import { resolve } from "node:path";
import db from "./db";
import { dockerFetch } from "./docker";

type DomainProject = {
  id: number;
  name: string;
  domain: string;
  domain_port: number;
};

const DATA_DIR = resolve(import.meta.dir, "..", "..", "data");
const CADDY_ROUTES_PATH = resolve(DATA_DIR, "moor-routes");
const CADDY_CONFIG_PATH = resolve(DATA_DIR, "Caddyfile");
const CADDY_CONTAINER = "moor-caddy-1";

const DEFAULT_CADDYFILE = `\
# Replace :80 with your domain (e.g. moor.example.com) to enable auto HTTPS
:80 {
\theader {
\t\tX-Content-Type-Options "nosniff"
\t\tX-Frame-Options "DENY"
\t\tReferrer-Policy "strict-origin-when-cross-origin"
\t}
\treverse_proxy moor:3000
}

# Domain routes managed by Moor — do not edit manually
import /app/data/moor-routes
`;

/** Generate a Caddyfile snippet from all projects with domains configured. */
function generateRoutes(projects: DomainProject[]): string {
  if (projects.length === 0) return "# No domain routes configured\n";

  return projects
    .filter((p) => p.domain_port != null)
    .map((p) => `${p.domain} {\n\treverse_proxy moor-${p.name}:${p.domain_port}\n}`)
    .join("\n\n")
    .concat("\n");
}

/** Write moor-routes file and reload Caddy. Called after any domain config change. */
export async function syncCaddyRoutes(): Promise<void> {
  const projects = db
    .query(
      `SELECT id, name, domain,
              COALESCE(domain_port, (SELECT container_port FROM port_mappings WHERE project_id = projects.id ORDER BY container_port LIMIT 1)) AS domain_port
       FROM projects
       WHERE domain IS NOT NULL AND domain != ''`,
    )
    .all() as DomainProject[];

  const content = generateRoutes(projects);
  await Bun.write(CADDY_ROUTES_PATH, content);
  console.log(`[caddy] wrote ${projects.length} route(s) to ${CADDY_ROUTES_PATH}`);

  await reloadCaddy();
}

/** Reload Caddy by exec'ing `caddy reload` in the Caddy container via the Docker Engine API.
 *  The moor production image does not ship the `docker` CLI, so shell-out doesn't work.
 *  Throws on failure so callers can surface the error. */
async function reloadCaddy(): Promise<void> {
  const createRes = await dockerFetch(`/v1.44/containers/${CADDY_CONTAINER}/exec`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      AttachStdout: true,
      AttachStderr: true,
      Cmd: ["caddy", "reload", "--config", "/app/data/Caddyfile", "--adapter", "caddyfile"],
    }),
  });
  if (createRes.status === 404) {
    console.warn(`[caddy] reload skipped: container ${CADDY_CONTAINER} not found (dev mode?)`);
    return;
  }
  if (!createRes.ok) {
    throw new Error(`caddy exec create failed: ${createRes.status} ${createRes.statusText}`);
  }
  const { Id } = (await createRes.json()) as { Id: string };

  const startRes = await dockerFetch(`/v1.44/exec/${Id}/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ Detach: false, Tty: false }),
  });
  if (!startRes.ok) {
    throw new Error(`caddy exec start failed: ${startRes.status} ${startRes.statusText}`);
  }
  // Drain the multiplexed stdout/stderr stream so the exec actually completes
  await startRes.arrayBuffer();

  const inspectRes = await dockerFetch(`/v1.44/exec/${Id}/json`);
  if (!inspectRes.ok) {
    throw new Error(`caddy exec inspect failed: ${inspectRes.status}`);
  }
  const { ExitCode } = (await inspectRes.json()) as { ExitCode: number | null };
  if (ExitCode !== 0) {
    throw new Error(`caddy reload exited ${ExitCode}`);
  }
  console.log("[caddy] reloaded successfully");
}

/** Ensure the Caddyfile and moor-routes exist in the data volume. */
export async function ensureRoutesFile(): Promise<void> {
  const routesFile = Bun.file(CADDY_ROUTES_PATH);
  if (!(await routesFile.exists())) {
    await Bun.write(CADDY_ROUTES_PATH, "# No domain routes configured\n");
    console.log("[caddy] created empty moor-routes file");
  }

  const caddyFile = Bun.file(CADDY_CONFIG_PATH);
  if (!(await caddyFile.exists())) {
    await Bun.write(CADDY_CONFIG_PATH, DEFAULT_CADDYFILE);
    console.log("[caddy] created default Caddyfile");
  }
}

/** Check if a domain's DNS resolves and optionally matches the server's IP. */
export async function checkDns(
  domain: string,
): Promise<{ resolves: boolean; ip: string | null; serverIp: string | null }> {
  let ip: string | null = null;
  let serverIp: string | null = null;

  try {
    const proc = Bun.spawn(["dig", "+short", domain], { stdout: "pipe", stderr: "pipe" });
    await proc.exited;
    const output = (await new Response(proc.stdout).text()).trim();
    // dig may return multiple lines; take the first A record (IPv4)
    const firstIp = output.split("\n").find((line) => /^\d+\.\d+\.\d+\.\d+$/.test(line));
    ip = firstIp || null;
  } catch {
    // dig not available
  }

  try {
    const proc = Bun.spawn(["curl", "-s", "-4", "https://ifconfig.me"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    const output = (await new Response(proc.stdout).text()).trim();
    if (/^\d+\.\d+\.\d+\.\d+$/.test(output)) {
      serverIp = output;
    }
  } catch {
    // curl not available
  }

  return { resolves: ip !== null, ip, serverIp };
}
