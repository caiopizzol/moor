#!/usr/bin/env bun
import { McpServer, StdioServerTransport } from "@modelcontextprotocol/server";
import { z } from "zod";
import { tailUtf8 } from "./tail-utf8";

// --- Config ---

const baseUrl = (process.env.MOOR_URL || "").replace(/\/$/, "");
const apiKey = process.env.MOOR_API_KEY || "";

if (!baseUrl || !apiKey) {
  console.error("MOOR_URL and MOOR_API_KEY environment variables are required");
  process.exit(1);
}

// --- Startup probe ---
// Fail closed: verify URL is reachable AND the bearer token authenticates before
// registering tools. Misconfigs surface here with a clear stderr message instead
// of later as opaque tool-call failures inside the MCP client.
{
  let probeRes: Response;
  try {
    probeRes = await fetch(`${baseUrl}/api/projects`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`Cannot reach moor at ${baseUrl}: ${msg}`);
    console.error("Check MOOR_URL and that moor is running (and tunneled, if remote).");
    process.exit(1);
  }
  if (probeRes.status === 401) {
    console.error(`Authentication failed against ${baseUrl}.`);
    console.error("Check MOOR_API_KEY matches the value in moor's .env on the server.");
    process.exit(1);
  }
  if (probeRes.status === 503) {
    console.error(`moor at ${baseUrl} returned 503.`);
    console.error("Likely cause: MOOR_INITIAL_PASSWORD not configured. Set it and restart moor.");
    process.exit(1);
  }
  if (!probeRes.ok) {
    console.error(`moor at ${baseUrl} returned ${probeRes.status} on startup probe.`);
    process.exit(1);
  }
}

// --- HTTP client ---

function headers(json = false): Record<string, string> {
  const h: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
  if (json) h["Content-Type"] = "application/json";
  return h;
}

async function apiGet(path: string) {
  return fetch(`${baseUrl}${path}`, { headers: headers() });
}

async function apiPost(path: string, body?: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: headers(body !== undefined),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function apiPut(path: string, body: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method: "PUT",
    headers: headers(true),
    body: JSON.stringify(body),
  });
}

async function apiDelete(path: string) {
  return fetch(`${baseUrl}${path}`, {
    method: "DELETE",
    headers: headers(),
  });
}

type Project = {
  id: number;
  name: string;
  status: string;
  container_id: string | null;
  image_tag: string | null;
  domain: string | null;
  docker_image: string | null;
  github_url: string | null;
};

async function resolveProject(name: string): Promise<Project> {
  const res = await apiGet("/api/projects");
  if (!res.ok) throw new Error(`Failed to list projects: ${res.status}`);
  const projects = (await res.json()) as Project[];
  const match = projects.find((p) => p.name === name || String(p.id) === name);
  if (!match) throw new Error(`Project "${name}" not found`);
  return match;
}

// --- SSE stream reader ---

async function readSSE(res: Response): Promise<{ logs: string; error?: string }> {
  const reader = res.body?.getReader();
  if (!reader) return { logs: "" };

  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "";
  let logs = "";
  let error: string | undefined;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (line.startsWith("event: ")) {
        currentEvent = line.slice(7).trim();
      } else if (line.startsWith("data: ")) {
        const data = JSON.parse(line.slice(6));
        if (currentEvent === "log") logs += data;
        else if (currentEvent === "error") error = data;
        currentEvent = "";
      }
    }
  }
  return { logs, error };
}

// --- Validators ---

/** Validate that a string is a github.com URL. Throws with a clear message on failure.
 *  Stricter than apps/api/routes/docker.ts:validateGithubUrl, which accepts any host
 *  ending in "github.com" (so "evilgithub.com" slips through). MCP rejects that and
 *  surfaces the error at create/update time, not at first build/run. */
function validateGithubUrl(url: string): void {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error(`github_url is not a valid URL: ${url}`);
  }
  if (host !== "github.com" && !host.endsWith(".github.com")) {
    throw new Error(`github_url must be a github.com URL (got hostname "${host}")`);
  }
}

/** Strict GitHub repo URL validator used by moor_deploy. Stricter than
 *  validateGithubUrl: requires host = github.com or www.github.com AND a path of
 *  exactly /owner/repo (with optional .git suffix, optional trailing slash).
 *  Rejects gist.github.com, the bare root, and /owner/repo/tree/... extras.
 *  Failed deploys trigger an actual image build/pull, so the up-front check is
 *  worth being pickier than the create/update wrappers. */
function validateGithubRepoUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`github_url is not a valid URL: ${url}`);
  }
  // The downstream build path (apps/api/docker.ts:buildImage) appends ".git" and a
  // branch ref to whatever URL we forward, so a non-http protocol, query string, or
  // fragment quietly mangles the resulting git remote. Reject those up front.
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`github_url must use http or https (got protocol "${parsed.protocol}")`);
  }
  if (parsed.search) {
    throw new Error(`github_url must not contain query parameters (got "${parsed.search}")`);
  }
  if (parsed.hash) {
    throw new Error(`github_url must not contain a URL fragment (got "${parsed.hash}")`);
  }
  const host = parsed.hostname;
  if (host !== "github.com" && host !== "www.github.com") {
    throw new Error(`github_url must use github.com or www.github.com (got "${host}")`);
  }
  if (!/^\/[^/]+\/[^/]+?(\.git)?\/?$/.test(parsed.pathname)) {
    throw new Error(
      `github_url must point to /owner/repo (with optional .git); got "${parsed.pathname}"`,
    );
  }
}

/** Validate a 5-field crontab schedule against what apps/api/cron.ts can actually execute.
 *  Stricter than the scheduler's permissive parser: the scheduler silently never fires
 *  on bad input, so MCP rejects up-front. Returns an error string or null. */
const CRON_FIELDS: ReadonlyArray<{ name: string; min: number; max: number }> = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day-of-week", min: 0, max: 6 }, // 0=Sunday; scheduler does not translate 7
];

// Whitelist each comma-separated part against one of the canonical forms below.
// Anything else (empty parts, leading "-", bare "N/S", "/S", stray characters) is
// rejected. The scheduler at apps/api/cron.ts silently ignores or mis-parses these
// inputs, so the validator must be strict where the scheduler is loose.
const CRON_PART_PATTERNS = [
  /^\*$/, // *
  /^(\d+)$/, // N
  /^(\d+)-(\d+)$/, // A-B
  /^\*\/(\d+)$/, // */S
  /^(\d+)-(\d+)\/(\d+)$/, // A-B/S
];

function validateCronField(field: string, min: number, max: number, name: string): string | null {
  if (field === "*") return null;
  if (/[?LW#]/i.test(field)) return `${name}: ?, L, W, # are not supported`;
  if (/[a-zA-Z]/.test(field))
    return `${name}: month/day names are not supported, use numeric values`;

  for (const part of field.split(",")) {
    if (part === "") return `${name}: empty list element`;

    const match = CRON_PART_PATTERNS.map((re) => part.match(re)).find((m) => m !== null);
    if (!match) return `${name}: invalid expression "${part}"`;

    // Validate captured numbers against per-field bounds and step positivity.
    // Capture layout depends on which pattern matched, identified by length.
    const groups = match.slice(1);
    if (groups.length === 1 && match[0].startsWith("*/")) {
      // */S
      const step = Number(groups[0]);
      if (step <= 0) return `${name}: step must be a positive integer (got "${groups[0]}")`;
    } else if (groups.length === 1) {
      // N
      const n = Number(groups[0]);
      if (n < min || n > max) return `${name}: ${n} out of bounds [${min}-${max}]`;
    } else if (groups.length === 2) {
      // A-B
      const a = Number(groups[0]);
      const b = Number(groups[1]);
      if (a < min || b > max) return `${name}: range ${a}-${b} out of bounds [${min}-${max}]`;
      if (a > b) return `${name}: range ${a}-${b} is descending`;
    } else if (groups.length === 3) {
      // A-B/S
      const a = Number(groups[0]);
      const b = Number(groups[1]);
      const step = Number(groups[2]);
      if (a < min || b > max) return `${name}: range ${a}-${b} out of bounds [${min}-${max}]`;
      if (a > b) return `${name}: range ${a}-${b} is descending`;
      if (step <= 0) return `${name}: step must be a positive integer (got "${groups[2]}")`;
    }
  }
  return null;
}

function validateCronSchedule(schedule: string): string | null {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) {
    return `schedule must have exactly 5 space-separated fields (got ${parts.length})`;
  }
  for (let i = 0; i < 5; i++) {
    const err = validateCronField(
      parts[i],
      CRON_FIELDS[i].min,
      CRON_FIELDS[i].max,
      CRON_FIELDS[i].name,
    );
    if (err) return err;
  }
  return null;
}

// --- MCP Server ---

const server = new McpServer({
  name: "moor",
  version: "0.1.0",
});

// --- Tools ---

server.registerTool(
  "moor_status",
  {
    title: "List Projects",
    description: "List all projects managed by Moor with their status, source, and domain.",
  },
  async () => {
    const res = await apiGet("/api/projects");
    if (!res.ok) throw new Error(`Failed: ${res.status}`);
    const projects = (await res.json()) as Project[];
    const summary = projects.map((p) => ({
      name: p.name,
      status: p.status,
      source: p.docker_image || p.github_url || null,
      domain: p.domain,
    }));
    return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
  },
);

server.registerTool(
  "moor_logs",
  {
    title: "Get Container Logs",
    description: "Get recent logs from a project's container.",
    inputSchema: z.object({
      project: z.string().describe("Project name or ID"),
      lines: z.number().optional().default(100).describe("Number of log lines to retrieve"),
    }),
  },
  async ({ project, lines }) => {
    const p = await resolveProject(project);
    const res = await apiGet(`/api/projects/${p.id}/logs?tail=${lines}`);
    if (!res.ok) throw new Error(`Failed: ${res.status}`);
    const data = (await res.json()) as { logs: string };
    return {
      content: [{ type: "text", text: data.logs || "(no logs)" }],
    };
  },
);

server.registerTool(
  "moor_rebuild",
  {
    title: "Rebuild Project",
    description:
      "Rebuild a project from source (git pull + docker build) and restart the container. Returns the build output.",
    inputSchema: z.object({
      project: z.string().describe("Project name or ID"),
      no_cache: z.boolean().optional().default(false).describe("Build without Docker cache"),
    }),
  },
  async ({ project, no_cache }) => {
    const p = await resolveProject(project);
    const query = no_cache ? "?nocache=true" : "";
    const res = await apiPost(`/api/projects/${p.id}/run${query}`);
    const { logs, error } = await readSSE(res);
    if (error) throw new Error(error);
    return { content: [{ type: "text", text: logs || "Rebuild complete." }] };
  },
);

server.registerTool(
  "moor_restart",
  {
    title: "Restart Project",
    description: "Stop and start a project's container.",
    inputSchema: z.object({
      project: z.string().describe("Project name or ID"),
    }),
  },
  async ({ project }) => {
    const p = await resolveProject(project);
    const stopRes = await apiPost(`/api/projects/${p.id}/stop`);
    if (!stopRes.ok) throw new Error(`Failed to stop: ${await stopRes.text()}`);
    const startRes = await apiPost(`/api/projects/${p.id}/start`);
    if (!startRes.ok) throw new Error(`Failed to start: ${await startRes.text()}`);
    return { content: [{ type: "text", text: `${p.name} restarted.` }] };
  },
);

server.registerTool(
  "moor_exec",
  {
    title: "Execute Command",
    description:
      "Run a shell command inside a project's running container. Bounded by a per-call timeout (default 10 min, max 1 h). For jobs that may exceed an hour, wait for the async exec tools to ship.",
    inputSchema: z.object({
      project: z.string().describe("Project name or ID"),
      command: z.string().describe("Shell command to execute"),
      timeout_ms: z
        .number()
        .int()
        .min(1000)
        .max(3_600_000)
        .optional()
        .describe(
          "Max time in milliseconds before the exec is aborted. Default 600000 (10 min). Max 3600000 (1 h).",
        ),
    }),
  },
  async ({ project, command, timeout_ms }) => {
    const p = await resolveProject(project);
    const body: Record<string, unknown> = { command };
    if (timeout_ms !== undefined) body.timeout_ms = timeout_ms;
    const res = await apiPost(`/api/projects/${p.id}/exec`, body);
    // The API returns 504 with a structured timeout body when the exec hit
    // timeout_ms. Surface the kill outcome in the tool error so the agent can
    // tell "the process was actually stopped" from "we just stopped waiting."
    if (res.status === 504) {
      const t = (await res.json()) as {
        timeout_ms: number;
        killed: boolean;
        killed_pid: string | null;
        live_remaining: number;
        message: string;
      };
      let detail: string;
      if (t.killed) {
        detail = `Process tree terminated (container pid ${t.killed_pid}).`;
      } else if (t.killed_pid !== null) {
        detail = `Kill attempted on container pid ${t.killed_pid} but ${t.live_remaining} descendant process(es) still running inside the container.`;
      } else {
        detail =
          "Process kill could not locate the running process — it may still be running inside the container.";
      }
      throw new Error(`Exec timed out after ${t.timeout_ms}ms. ${detail}`);
    }
    if (!res.ok) throw new Error(`Failed: ${await res.text()}`);
    const result = (await res.json()) as {
      exitCode: number;
      stdout: string;
      stderr: string;
    };
    let text = "";
    if (result.stdout) text += result.stdout;
    if (result.stderr) text += `\n[stderr] ${result.stderr}`;
    text += `\n[exit code: ${result.exitCode}]`;
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "moor_env_list",
  {
    title: "List Environment Variables",
    description: "List all environment variables set for a project.",
    inputSchema: z.object({
      project: z.string().describe("Project name or ID"),
    }),
  },
  async ({ project }) => {
    const p = await resolveProject(project);
    const res = await apiGet(`/api/projects/${p.id}/envs`);
    if (!res.ok) throw new Error(`Failed: ${res.status}`);
    const vars = (await res.json()) as { key: string; value: string }[];
    if (vars.length === 0)
      return { content: [{ type: "text", text: "No environment variables set." }] };
    const text = vars.map((v) => `${v.key}=${v.value}`).join("\n");
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "moor_env_set",
  {
    title: "Set Environment Variables",
    description:
      "Set environment variables for a project. Merges with existing vars. Automatically restarts the container if running.",
    inputSchema: z.object({
      project: z.string().describe("Project name or ID"),
      vars: z
        .record(z.string(), z.string())
        .describe('Key-value pairs to set, e.g. { "DATABASE_URL": "postgres://..." }'),
    }),
  },
  async ({ project, vars }) => {
    const p = await resolveProject(project);

    // Fetch existing and merge
    const existingRes = await apiGet(`/api/projects/${p.id}/envs`);
    if (!existingRes.ok) throw new Error(`Failed to get envs: ${existingRes.status}`);
    const existing = (await existingRes.json()) as { key: string; value: string }[];
    const merged = new Map(existing.map((v) => [v.key, v.value]));
    for (const [key, value] of Object.entries(vars)) {
      merged.set(key, value);
    }
    const allVars = Array.from(merged, ([key, value]) => ({ key, value }));

    const setRes = await apiPut(`/api/projects/${p.id}/envs`, allVars);
    if (!setRes.ok) throw new Error(`Failed to set envs: ${await setRes.text()}`);

    const keys = Object.keys(vars).join(", ");
    let text = `Set ${keys} on ${p.name}.`;

    // Restart if running
    if (p.status === "running") {
      await apiPost(`/api/projects/${p.id}/stop`);
      const startRes = await apiPost(`/api/projects/${p.id}/start`);
      if (!startRes.ok) throw new Error(`Set vars but failed to restart: ${await startRes.text()}`);
      text += " Container restarted.";
    }

    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "moor_stats",
  {
    title: "Server Stats",
    description: "Get server resource usage: CPU, memory, disk, and container counts.",
  },
  async () => {
    const res = await apiGet("/api/server/stats");
    if (!res.ok) throw new Error(`Failed: ${res.status}`);
    const s = (await res.json()) as {
      hostname: string;
      os: string;
      uptime: string;
      cpu: { percent: number; cores: number };
      memory: { total: string; used: string; percent: number };
      disk: { total: string; used: string; percent: number };
      containers: { running: number; total: number };
    };
    const text = [
      `Host: ${s.hostname}`,
      `OS: ${s.os}`,
      `Uptime: ${s.uptime}`,
      `CPU: ${s.cpu.percent}% (${s.cpu.cores} cores)`,
      `Memory: ${s.memory.used} / ${s.memory.total} (${s.memory.percent}%)`,
      `Disk: ${s.disk.used} / ${s.disk.total} (${s.disk.percent}%)`,
      `Containers: ${s.containers.running} running / ${s.containers.total} total`,
    ].join("\n");
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "moor_project_get",
  {
    title: "Get Project",
    description:
      "Returns the full record for a project (source, branch, dockerfile, domain, status, container id, restart policy).",
    inputSchema: z.object({
      project: z.string().describe("Project name or ID"),
    }),
  },
  async ({ project }) => {
    const p = await resolveProject(project);
    return { content: [{ type: "text", text: JSON.stringify(p, null, 2) }] };
  },
);

server.registerTool(
  "moor_project_create",
  {
    title: "Create Project",
    description:
      "Creates a new project. Provide exactly one of github_url or docker_image. Does not build or start; call moor_rebuild (or moor_deploy in a future release) to bring it up.",
    inputSchema: z.object({
      name: z
        .string()
        .regex(
          /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/,
          "name must start with an alphanumeric character; allowed chars: a-z, A-Z, 0-9, _, -",
        )
        .describe("Project name (used as the container name suffix: moor-<name>)"),
      github_url: z
        .string()
        .optional()
        .describe("github.com URL; mutually exclusive with docker_image"),
      docker_image: z
        .string()
        .optional()
        .describe("Docker image reference (e.g. nginx:latest); mutually exclusive with github_url"),
      branch: z.string().optional().describe("Git branch (default: main, for github_url projects)"),
      dockerfile: z
        .string()
        .optional()
        .describe("Dockerfile path within the repo (default: Dockerfile)"),
      domain: z.string().optional().describe("Public domain to route to this container via Caddy"),
      domain_port: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Container port Caddy should forward to (required if domain is set)"),
      restart_policy: z
        .enum(["no", "on-failure", "always", "unless-stopped"])
        .optional()
        .describe("Docker restart policy (default: unless-stopped)"),
      memory_limit_mb: z
        .number()
        .int()
        .min(6)
        .optional()
        .describe(
          "Max RAM in MB (also caps swap to the same value so the container can't burn through host swap). Min 6 (Docker's floor), max host total memory. Omit for unbounded. Takes effect on container recreate (next moor_rebuild / moor_restart / moor_deploy / moor_project run).",
        ),
      cpus: z
        .number()
        .positive()
        .optional()
        .describe(
          "Max CPU cores. Fractional values OK (e.g. 0.5 = half a core). Min 0.001 (anything smaller rounds to Docker NanoCpus=0, which means unlimited — use omit for that). Max host core count. Takes effect on container recreate.",
        ),
    }),
  },
  async (input) => {
    const sources = (input.github_url ? 1 : 0) + (input.docker_image ? 1 : 0);
    if (sources !== 1) {
      throw new Error("Provide exactly one of github_url or docker_image");
    }
    if (input.github_url) validateGithubUrl(input.github_url);

    const res = await apiPost("/api/projects", input);
    if (!res.ok) throw new Error(`Failed to create project: ${await res.text()}`);
    const project = await res.json();
    return { content: [{ type: "text", text: JSON.stringify(project, null, 2) }] };
  },
);

server.registerTool(
  "moor_project_update",
  {
    title: "Update Project",
    description:
      "Updates project metadata. Does NOT rebuild or restart the container. Domain or domain_port changes apply to Caddy immediately. Resource-limit changes (memory_limit_mb, cpus) take effect on the next container recreate (moor_rebuild / moor_restart / moor_deploy / moor_project run) — an already-running container keeps its existing limits.",
    inputSchema: z.object({
      project: z.string().describe("Project name or ID to update"),
      name: z
        .string()
        .regex(
          /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/,
          "name must start alphanumeric; allowed: a-z A-Z 0-9 _ -",
        )
        .optional(),
      github_url: z.string().optional(),
      docker_image: z.string().optional(),
      branch: z.string().optional(),
      dockerfile: z.string().optional(),
      domain: z.string().optional(),
      domain_port: z.number().int().positive().optional(),
      restart_policy: z.enum(["no", "on-failure", "always", "unless-stopped"]).optional(),
      memory_limit_mb: z
        .number()
        .int()
        .min(6)
        .nullable()
        .optional()
        .describe(
          "Max RAM in MB. Pass null to clear (return to unbounded). Min 6, max host total memory. Takes effect on container recreate.",
        ),
      cpus: z
        .number()
        .positive()
        .nullable()
        .optional()
        .describe(
          "Max CPU cores (fractional OK; min 0.001). Pass null to clear. Max host core count. Takes effect on container recreate.",
        ),
    }),
  },
  async (input) => {
    const { project, ...updates } = input;
    if (Object.keys(updates).length === 0) {
      throw new Error("Provide at least one field to update");
    }
    if (updates.github_url && updates.docker_image) {
      throw new Error("Cannot set both github_url and docker_image in the same update");
    }
    if (updates.github_url) validateGithubUrl(updates.github_url);

    const p = await resolveProject(project);
    const res = await apiPut(`/api/projects/${p.id}`, updates);
    if (!res.ok) throw new Error(`Failed to update project: ${await res.text()}`);
    const updated = await res.json();
    return { content: [{ type: "text", text: JSON.stringify(updated, null, 2) }] };
  },
);

server.registerTool(
  "moor_project_delete",
  {
    title: "Delete Project",
    description:
      "Stops and removes the container, then deletes the project record. Requires confirm_name to match the resolved project name exactly. Irreversible.",
    inputSchema: z.object({
      project: z.string().describe("Project name or ID to delete"),
      confirm_name: z
        .string()
        .describe(
          "Must equal the resolved project's name. Guards against deleting the wrong project.",
        ),
    }),
  },
  async ({ project, confirm_name }) => {
    const p = await resolveProject(project);
    if (confirm_name !== p.name) {
      throw new Error(
        `confirm_name "${confirm_name}" does not match resolved project name "${p.name}". Refusing to delete.`,
      );
    }
    const res = await apiDelete(`/api/projects/${p.id}`);
    if (!res.ok) throw new Error(`Failed to delete project: ${await res.text()}`);
    return { content: [{ type: "text", text: `Deleted project ${p.name} (id=${p.id}).` }] };
  },
);

server.registerTool(
  "moor_cron_create",
  {
    title: "Create Cron",
    description:
      "Creates a cron schedule on a project. Schedule is a 5-field crontab string with numeric values only (no jan/sun/etc.). Day-of-week uses 0=Sunday through 6=Saturday; 7 is not accepted.",
    inputSchema: z.object({
      project: z.string().describe("Project name or ID"),
      name: z.string().min(1).describe("Human-readable name for the cron"),
      schedule: z.string().describe('5-field crontab, e.g. "0 3 * * *" for 03:00 daily'),
      command: z.string().min(1).describe("Shell command to run inside the project's container"),
    }),
  },
  async ({ project, name, schedule, command }) => {
    const err = validateCronSchedule(schedule);
    if (err) throw new Error(`Invalid schedule: ${err}`);
    const p = await resolveProject(project);
    const res = await apiPost(`/api/projects/${p.id}/crons`, { name, schedule, command });
    if (!res.ok) throw new Error(`Failed to create cron: ${await res.text()}`);
    const cron = await res.json();
    return { content: [{ type: "text", text: JSON.stringify(cron, null, 2) }] };
  },
);

server.registerTool(
  "moor_cron_update",
  {
    title: "Update Cron",
    description: "Updates a cron's fields by id. Schedule is validated if provided.",
    inputSchema: z.object({
      cron_id: z.number().int().positive().describe("Cron ID"),
      name: z.string().min(1).optional(),
      schedule: z.string().optional(),
      command: z.string().min(1).optional(),
      enabled: z.boolean().optional().describe("Enable or disable the cron"),
    }),
  },
  async ({ cron_id, name, schedule, command, enabled }) => {
    if (schedule !== undefined) {
      const err = validateCronSchedule(schedule);
      if (err) throw new Error(`Invalid schedule: ${err}`);
    }
    const body: Record<string, unknown> = {};
    if (name !== undefined) body.name = name;
    if (schedule !== undefined) body.schedule = schedule;
    if (command !== undefined) body.command = command;
    if (enabled !== undefined) body.enabled = enabled ? 1 : 0;
    if (Object.keys(body).length === 0) {
      throw new Error("Provide at least one field to update");
    }
    const res = await apiPut(`/api/crons/${cron_id}`, body);
    if (!res.ok) throw new Error(`Failed to update cron: ${await res.text()}`);
    const cron = await res.json();
    return { content: [{ type: "text", text: JSON.stringify(cron, null, 2) }] };
  },
);

server.registerTool(
  "moor_cron_delete",
  {
    title: "Delete Cron",
    description: "Deletes a cron by id.",
    inputSchema: z.object({
      cron_id: z.number().int().positive().describe("Cron ID"),
    }),
  },
  async ({ cron_id }) => {
    const res = await apiDelete(`/api/crons/${cron_id}`);
    if (!res.ok) throw new Error(`Failed to delete cron: ${await res.text()}`);
    // API returns 204 whether or not the row existed; phrase the response so it
    // doesn't claim a row was removed when it might already have been gone.
    return { content: [{ type: "text", text: `Deletion requested for cron ${cron_id}.` }] };
  },
);

server.registerTool(
  "moor_cron_run",
  {
    title: "Run Cron Now",
    description:
      "Triggers a cron to run immediately. Requires the project's container to be running.",
    inputSchema: z.object({
      cron_id: z.number().int().positive().describe("Cron ID"),
    }),
  },
  async ({ cron_id }) => {
    const res = await apiPost(`/api/crons/${cron_id}/run`);
    if (!res.ok) {
      const text = await res.text();
      let message = text;
      try {
        const parsed = JSON.parse(text);
        if (parsed?.error) message = parsed.error;
      } catch {
        // Not JSON; use raw text
      }
      throw new Error(message);
    }
    return { content: [{ type: "text", text: `Triggered cron ${cron_id}.` }] };
  },
);

server.registerTool(
  "moor_env_delete",
  {
    title: "Delete Environment Variables",
    description:
      "Removes one or more environment variables from a project. Restarts the container only if at least one key was actually deleted AND the project was running.",
    inputSchema: z.object({
      project: z.string().describe("Project name or ID"),
      keys: z.array(z.string().min(1)).min(1).describe("Env var keys to remove"),
    }),
  },
  async ({ project, keys }) => {
    const p = await resolveProject(project);

    const existingRes = await apiGet(`/api/projects/${p.id}/envs`);
    if (!existingRes.ok) throw new Error(`Failed to get envs: ${existingRes.status}`);
    const existing = (await existingRes.json()) as { key: string; value: string }[];
    const existingKeys = new Set(existing.map((v) => v.key));

    const toDelete = keys.filter((k) => existingKeys.has(k));
    const missing = keys.filter((k) => !existingKeys.has(k));

    if (toDelete.length === 0) {
      const existingList = [...existingKeys].sort().join(", ") || "(none)";
      return {
        content: [
          {
            type: "text",
            text: `No matching keys on ${p.name}. Existing keys: ${existingList}`,
          },
        ],
      };
    }

    for (const key of toDelete) {
      const res = await apiDelete(`/api/projects/${p.id}/envs/${encodeURIComponent(key)}`);
      if (!res.ok) throw new Error(`Failed to delete ${key}: ${await res.text()}`);
    }

    let text = `Deleted ${toDelete.join(", ")} from ${p.name}.`;
    if (missing.length > 0) text += ` (Not present: ${missing.join(", ")}.)`;

    if (p.status === "running") {
      await apiPost(`/api/projects/${p.id}/stop`);
      const startRes = await apiPost(`/api/projects/${p.id}/start`);
      if (!startRes.ok) {
        throw new Error(`Deleted vars but failed to restart: ${await startRes.text()}`);
      }
      text += " Container restarted.";
    }

    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "moor_dns_check",
  {
    title: "Check Domain DNS",
    description:
      "Resolves a domain's A record and reports whether it matches the server's public IP. Useful before pointing a project's domain at the server.",
    inputSchema: z.object({
      domain: z.string().min(1).describe("Domain to check, e.g. app.example.com"),
    }),
  },
  async ({ domain }) => {
    const res = await apiPost("/api/dns-check", { domain });
    if (!res.ok) throw new Error(`Failed: ${await res.text()}`);
    const data = (await res.json()) as {
      resolves: boolean;
      ip: string | null;
      serverIp: string | null;
    };
    const lines = [
      `Domain: ${domain}`,
      `Resolves: ${data.resolves ? "yes" : "no"}`,
      `Resolved IP: ${data.ip ?? "(none)"}`,
      `Server IP: ${data.serverIp ?? "(unknown)"}`,
    ];
    if (data.ip && data.serverIp) {
      lines.push(`Match: ${data.ip === data.serverIp ? "yes" : "no"}`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

server.registerTool(
  "moor_deploy",
  {
    title: "Deploy Project",
    description:
      "Create-or-update a project end to end: metadata, env vars (merged into existing), and an optional build/run. Default fails if the project already exists; pass update_existing: true to upsert. When run: true (default), waits for the full Docker build/pull and start, which can take minutes for large images. Errors are tagged by the failing step ([create], [update], [set_env], or [run]) and do not roll back earlier steps.",
    inputSchema: z.object({
      name: z
        .string()
        .regex(
          /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/,
          "name must start alphanumeric; allowed chars: a-z A-Z 0-9 _ -",
        )
        .describe("Project name (also the container suffix: moor-<name>)"),
      github_url: z
        .string()
        .optional()
        .describe(
          "GitHub repo URL: host must be github.com or www.github.com, path must be /owner/repo (optional .git). Mutually exclusive with docker_image.",
        ),
      docker_image: z
        .string()
        .optional()
        .describe(
          "Docker image reference (e.g. nginx:latest). Mutually exclusive with github_url.",
        ),
      branch: z.string().optional().describe("Git branch (API default: main)"),
      dockerfile: z
        .string()
        .optional()
        .describe("Dockerfile path in the repo (API default: Dockerfile)"),
      domain: z.string().optional().describe("Public domain to route via Caddy"),
      domain_port: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Container port Caddy should forward to"),
      restart_policy: z
        .enum(["no", "on-failure", "always", "unless-stopped"])
        .optional()
        .describe("Docker restart policy (API default: unless-stopped)"),
      memory_limit_mb: z
        .number()
        .int()
        .min(6)
        .nullable()
        .optional()
        .describe(
          "Max RAM in MB (also caps swap to the same value). Min 6, max host total memory. Pass null on update to clear. Limits apply on container recreate, which deploy always does when run: true.",
        ),
      cpus: z
        .number()
        .positive()
        .nullable()
        .optional()
        .describe(
          "Max CPU cores. Fractional OK (e.g. 0.5; min 0.001). Max host core count. Pass null on update to clear.",
        ),
      env: z
        .record(z.string(), z.string())
        .optional()
        .describe(
          "Env vars to MERGE into existing project envs. Omit to leave envs untouched. Pass {} for an explicit no-op. Use moor_env_delete to remove keys.",
        ),
      run: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          "Build/pull and start after create/update. Default true. Setting false leaves the container untouched; if envs changed while the container is running, the change will not apply until the next run/restart.",
        ),
      update_existing: z
        .boolean()
        .optional()
        .default(false)
        .describe("Allow updating a project that already exists. Default false (create-only)."),
    }),
  },
  async (input) => {
    // Up-front validation: do strict checks before any side effects.
    if (input.github_url) validateGithubRepoUrl(input.github_url);
    if (input.github_url && input.docker_image) {
      throw new Error("Cannot set both github_url and docker_image");
    }

    // Resolve existence and check domain conflicts from a single project list.
    const listRes = await apiGet("/api/projects");
    if (!listRes.ok) throw new Error(`Failed to list projects: ${listRes.status}`);
    const projects = (await listRes.json()) as Project[];
    const existing = projects.find((p) => p.name === input.name);

    if (existing && !input.update_existing) {
      throw new Error(
        `Project "${input.name}" already exists. Pass update_existing: true to update it.`,
      );
    }

    if (!existing) {
      const sources = (input.github_url ? 1 : 0) + (input.docker_image ? 1 : 0);
      if (sources !== 1) {
        throw new Error("Provide exactly one of github_url or docker_image");
      }
    }

    // Normalize once for both the conflict check and the write. The API trims but
    // does not lowercase, so " Example.com " vs an existing "example.com" would
    // slip past the raw-string pre-check and only surface as a Caddy collision.
    const normalizedDomain =
      input.domain === undefined ? undefined : input.domain.trim().toLowerCase() || null;

    if (normalizedDomain) {
      const conflict = projects.find(
        (p) =>
          p.domain && p.domain.trim().toLowerCase() === normalizedDomain && p.id !== existing?.id,
      );
      if (conflict) {
        throw new Error(
          `Domain "${normalizedDomain}" is already used by project "${conflict.name}" (id=${conflict.id}). Refusing before Caddy reload.`,
        );
      }
    }

    // Step 1: create or update project metadata.
    let projectId: number;
    let projectName: string;
    if (!existing) {
      const createBody: Record<string, unknown> = {
        name: input.name,
        github_url: input.github_url,
        docker_image: input.docker_image,
        branch: input.branch,
        dockerfile: input.dockerfile,
        domain: normalizedDomain,
        domain_port: input.domain_port,
        restart_policy: input.restart_policy,
        memory_limit_mb: input.memory_limit_mb,
        cpus: input.cpus,
      };
      const res = await apiPost("/api/projects", createBody);
      if (!res.ok) throw new Error(`[create] ${await res.text()}`);
      const created = (await res.json()) as Project;
      projectId = created.id;
      projectName = created.name;
    } else {
      // Update only fields explicitly provided. `name` is the lookup key here,
      // not a rename target; use moor_project_update for renames.
      const updateBody: Record<string, unknown> = {};
      if (input.github_url !== undefined) updateBody.github_url = input.github_url;
      if (input.docker_image !== undefined) updateBody.docker_image = input.docker_image;
      if (input.branch !== undefined) updateBody.branch = input.branch;
      if (input.dockerfile !== undefined) updateBody.dockerfile = input.dockerfile;
      if (normalizedDomain !== undefined) updateBody.domain = normalizedDomain;
      if (input.domain_port !== undefined) updateBody.domain_port = input.domain_port;
      if (input.restart_policy !== undefined) updateBody.restart_policy = input.restart_policy;
      if (input.memory_limit_mb !== undefined) updateBody.memory_limit_mb = input.memory_limit_mb;
      if (input.cpus !== undefined) updateBody.cpus = input.cpus;

      if (Object.keys(updateBody).length > 0) {
        const res = await apiPut(`/api/projects/${existing.id}`, updateBody);
        if (!res.ok) throw new Error(`[update] ${await res.text()}`);
      }
      projectId = existing.id;
      projectName = existing.name;
    }

    // Step 2: merge envs. Omitted env leaves existing untouched; {} is a no-op.
    const envEntries = input.env ? Object.entries(input.env) : [];
    const envProvided = envEntries.length > 0;
    if (envProvided) {
      const existingRes = await apiGet(`/api/projects/${projectId}/envs`);
      if (!existingRes.ok) {
        throw new Error(`[set_env] Failed to read envs: ${existingRes.status}`);
      }
      const existingEnvs = (await existingRes.json()) as { key: string; value: string }[];
      const merged = new Map(existingEnvs.map((v) => [v.key, v.value]));
      for (const [k, v] of envEntries) merged.set(k, v);
      const allVars = Array.from(merged, ([key, value]) => ({ key, value }));
      const putRes = await apiPut(`/api/projects/${projectId}/envs`, allVars);
      if (!putRes.ok) throw new Error(`[set_env] ${await putRes.text()}`);
    }

    // Step 3: run, default true. Wait for the full SSE stream like moor_rebuild.
    let runLogs = "";
    if (input.run) {
      const runRes = await apiPost(`/api/projects/${projectId}/run`);
      if (!runRes.ok) throw new Error(`[run] ${await runRes.text()}`);
      const { logs, error } = await readSSE(runRes);
      runLogs = logs;
      if (error) throw new Error(`[run] ${error}`);
    }

    const lines: string[] = [];
    lines.push(
      existing
        ? `Updated project ${projectName} (id=${projectId}).`
        : `Created project ${projectName} (id=${projectId}).`,
    );
    if (envProvided) {
      lines.push(
        `Merged ${envEntries.length} env var(s): ${envEntries.map(([k]) => k).join(", ")}.`,
      );
    }
    if (!input.run) {
      if (envProvided && existing?.status === "running") {
        lines.push(
          "Note: project is running; env changes will not take effect until the next run or restart.",
        );
      }
    } else {
      lines.push("");
      lines.push("Build/run output:");
      lines.push(runLogs || "(no output)");
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

// --- Async exec (#34 Phase B) ---

server.registerTool(
  "moor_exec_async",
  {
    title: "Start Async Exec",
    description:
      "Run a long-lived command inside a project's container, returning immediately with a run_id. Use moor_exec_status to poll for output and exit code; moor_exec_stop to terminate. Bounded by an optional timeout_ms (default 86400000 = 24h; min 60000 = 1 min; max 86400000). The recorded output is tail-truncated to the last 64 KiB per stream; stdout_total_bytes and stderr_total_bytes report the full pre-truncation byte count.",
    inputSchema: z.object({
      project: z.string().describe("Project name or ID"),
      command: z.string().min(1).describe("Shell command to execute"),
      timeout_ms: z
        .number()
        .int()
        .min(60_000)
        .max(86_400_000)
        .optional()
        .describe(
          "Safety timeout in milliseconds. When exceeded, the process tree is terminated and the run is marked timed_out. Default 86400000 (24h). Min 60000. Max 86400000.",
        ),
    }),
  },
  async ({ project, command, timeout_ms }) => {
    const p = await resolveProject(project);
    const body: Record<string, unknown> = { command };
    if (timeout_ms !== undefined) body.timeout_ms = timeout_ms;
    const res = await apiPost(`/api/projects/${p.id}/exec/async`, body);
    if (!res.ok) throw new Error(`Failed: ${await res.text()}`);
    const data = (await res.json()) as { run_id: number };
    return {
      content: [
        {
          type: "text",
          text: `Started async exec on ${p.name}. run_id=${data.run_id}. Use moor_exec_status to poll; moor_exec_stop to terminate.`,
        },
      ],
    };
  },
);

server.registerTool(
  "moor_exec_status",
  {
    title: "Get Async Exec Status",
    description:
      "Return the current state of an async exec run: state, exit code (when finished), running tail of stdout/stderr (default 8 KiB each inline; the API stores up to 64 KiB), total bytes seen, duration, and any error message. State is one of: running, exited, stopped, timed_out, error. Pass tail_bytes to control how many bytes of each stream are returned inline (0 to 65536; default 8192). The API's 64 KiB-per-stream storage cap is unchanged — tail_bytes only controls what the MCP tool returns to keep responses under typical agent token limits.",
    inputSchema: z.object({
      run_id: z.number().int().positive().describe("Run ID returned by moor_exec_async"),
      tail_bytes: z
        .number()
        .int()
        .min(0)
        .max(65_536)
        .optional()
        .describe(
          "Max bytes of each stream (stdout, stderr) returned inline. Default 8192. Max 65536 (the API storage cap). Set to 0 for metadata-only.",
        ),
    }),
  },
  async ({ run_id, tail_bytes }) => {
    const cap = tail_bytes ?? 8192;
    const res = await apiGet(`/api/exec/${run_id}`);
    if (res.status === 404) throw new Error(`run_id ${run_id} not found`);
    if (!res.ok) throw new Error(`Failed: ${await res.text()}`);
    const data = (await res.json()) as {
      id: number;
      state: string;
      exit_code: number | null;
      stdout: string;
      stderr: string;
      stdout_total_bytes: number;
      stderr_total_bytes: number;
      duration_ms: number;
      command: string;
      killed_pid: string | null;
      error_message: string | null;
      started_at: string;
      finished_at: string | null;
    };
    const lines: string[] = [];
    lines.push(
      `run_id=${data.id} state=${data.state} duration=${formatMs(data.duration_ms)}` +
        (data.exit_code !== null ? ` exit_code=${data.exit_code}` : ""),
    );
    lines.push(`command: ${data.command}`);
    if (data.killed_pid) lines.push(`killed_pid: ${data.killed_pid}`);
    if (data.error_message) lines.push(`error: ${data.error_message}`);
    appendStream(lines, "stdout", data.stdout, data.stdout_total_bytes, cap);
    appendStream(lines, "stderr", data.stderr, data.stderr_total_bytes, cap);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

function appendStream(
  lines: string[],
  name: string,
  raw: string,
  totalBytes: number,
  cap: number,
): void {
  if (!raw && totalBytes === 0) return;
  if (!raw) {
    // API returned an empty string but the stream did emit data (totalBytes > 0
    // is possible when no bytes survived API-side tail cap, though unlikely).
    lines.push(`${name}_total_bytes=${totalBytes}`);
    return;
  }
  const { tail, storedBytes, trimmed: mcpTrimmed } = tailUtf8(raw, cap);
  const apiTrimmed = totalBytes > storedBytes;
  let header: string;
  if (mcpTrimmed && apiTrimmed) {
    header = `${name} (showing last ${tail.length} chars of ${storedBytes} stored bytes; ${totalBytes} total bytes seen):`;
  } else if (mcpTrimmed) {
    header = `${name} (showing last ${tail.length} chars of ${storedBytes} total bytes):`;
  } else if (apiTrimmed) {
    header = `${name} (tail of ${storedBytes} stored from ${totalBytes} total bytes seen):`;
  } else {
    header = `${name}:`;
  }
  lines.push(header);
  if (cap > 0) lines.push(tail);
}

server.registerTool(
  "moor_exec_stop",
  {
    title: "Stop Async Exec",
    description:
      "Terminate a running async exec by run_id. Walks the descendant process tree inside the container and sends SIGTERM then SIGKILL. Always transitions the run to a terminal state: state=stopped on clean termination (all descendants gone), state=error if any descendant survived OR if the kill handle was lost (moor restart, missing pidfile). Stop is NOT retry-safe — the kill script removes the pidfile after every attempt, and reparented survivors are unreachable from the original PID.",
    inputSchema: z.object({
      run_id: z.number().int().positive().describe("Run ID returned by moor_exec_async"),
    }),
  },
  async ({ run_id }) => {
    const res = await apiPost(`/api/exec/${run_id}/stop`);
    if (res.status === 404) throw new Error(`run_id ${run_id} not found`);
    const data = (await res.json()) as {
      ok: boolean;
      state: string;
      killed_pid: string | null;
      live_remaining: number;
      message: string;
    };
    return {
      content: [
        {
          type: "text",
          text: `run_id=${run_id} state=${data.state} ${data.message}`,
        },
      ],
    };
  },
);

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h${rm}m${rs}s`;
}

// --- Start ---

const transport = new StdioServerTransport();
await server.connect(transport);
