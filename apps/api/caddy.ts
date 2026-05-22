import { promises as dns } from "node:dns";
import { resolve } from "node:path";
import db from "./db";
import { execInContainer, findCaddyContainerId } from "./docker";

type DomainProject = {
  id: number;
  name: string;
  domain: string;
  domain_port: number;
};

const DATA_DIR = resolve(import.meta.dir, "..", "..", "data");
const CADDY_ROUTES_PATH = resolve(DATA_DIR, "moor-routes");
const CADDY_CONFIG_PATH = resolve(DATA_DIR, "Caddyfile");

// Default Caddyfile shipped on first boot. The admin UI is intentionally NOT
// reverse-proxied here. Public exposure of the admin requires an explicit
// admin domain (added by editing this file or via project routes). Until then,
// admin is reachable on the host's loopback-bound moor:3000 via SSH tunnel.
// Unmatched hosts on :80 get a 421 (Misdirected Request).
const DEFAULT_CADDYFILE = `\
:80 {
\trespond 421
}

# Domain routes managed by Moor - do not edit manually
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
 *  Throws on failure so callers can surface the error. Set MOOR_SKIP_CADDY_RELOAD=1 to bypass
 *  (e.g. for `bun run dev:api` where there's no Caddy container). */
async function reloadCaddy(): Promise<void> {
  if (process.env.MOOR_SKIP_CADDY_RELOAD === "1") {
    console.warn("[caddy] reload skipped: MOOR_SKIP_CADDY_RELOAD=1");
    return;
  }

  const caddyContainerId = await findCaddyContainerId();
  const { exitCode, stdout, stderr } = await execInContainer(
    caddyContainerId,
    "caddy reload --config /app/data/Caddyfile --adapter caddyfile",
  );

  if (exitCode !== 0) {
    const detail = stderr.trim() || stdout.trim() || "no output";
    throw new Error(`caddy reload exited ${exitCode}: ${detail}`);
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

// #31: the previous implementation shelled out to `dig` and `curl` via Bun.spawn.
// Neither binary ships in the moor container image, so checkDns silently returned
// nulls for every domain. Switching to node:dns/promises and fetch removes the
// host-binary dependency and keeps the response shape unchanged.

const IPV4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const DNS_TIMEOUT_MS = 3000;
const SERVER_IP_TIMEOUT_MS = 3000;

/** Look up the first IPv4 A record for `domain`. ENOTFOUND, ENODATA, SERVFAIL,
 *  and timeouts all collapse to a null result, matching the existing contract
 *  ("the domain doesn't resolve"). The resolver is injectable for tests. */
export async function lookupA(
  domain: string,
  resolve4: (host: string) => Promise<string[]> = (host) => dns.resolve4(host),
): Promise<string | null> {
  try {
    const addrs = await withTimeout(resolve4(domain), DNS_TIMEOUT_MS);
    const first = addrs?.find((a) => IPV4.test(a));
    return first ?? null;
  } catch {
    return null;
  }
}

/** Fetch the server's public IPv4 from api.ipify.org. Returns null on any
 *  failure (timeout, network error, non-2xx, malformed body). Never throws. */
export async function getServerIp(fetchFn: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetchFn("https://api.ipify.org", {
      signal: AbortSignal.timeout(SERVER_IP_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const text = (await res.text()).trim();
    return IPV4.test(text) ? text : null;
  } catch {
    return null;
  }
}

/** Check if a domain's DNS resolves and optionally matches the server's IP. */
export async function checkDns(
  domain: string,
): Promise<{ resolves: boolean; ip: string | null; serverIp: string | null }> {
  const [ip, serverIp] = await Promise.all([lookupA(domain), getServerIp()]);
  return { resolves: ip !== null, ip, serverIp };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)),
  ]);
}
