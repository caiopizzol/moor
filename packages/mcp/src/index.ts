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
  // #71: live_* fields are written by the API's status reconciler.
  // status above is moor's RECORDED state (only changes on explicit
  // start/stop/build/cancel). live_status reflects Docker's view at
  // last successful inspect. Differences mean moor missed an external
  // change (or the reconciler hasn't run yet). live_error non-null
  // means the most recent inspect failed; the live_status / exit_code
  // shown is the last successful snapshot.
  live_status?: "running" | "stopped" | "error" | "missing" | null;
  live_exit_code?: number | null;
  live_checked_at?: string | null;
  live_error?: string | null;
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
  // The downstream build path (apps/api/docker.ts:buildImageStreaming) appends ".git"
  // and a branch ref to whatever URL we forward, so a non-http protocol, query string,
  // or fragment quietly mangles the resulting git remote. Reject those up front.
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
    description:
      "List all projects managed by Moor. `status` is moor's recorded state (only changes on explicit start/stop/build/cancel). `live_status` is Docker's view at last successful inspect; differences (e.g. recorded='running' live='error') mean moor missed an external change like a host docker stop, crash, or OOM kill. `live_error` non-null means the most recent inspect failed and the live_* values are the last successful snapshot, not necessarily current.",
  },
  async () => {
    const res = await apiGet("/api/projects");
    if (!res.ok) throw new Error(`Failed: ${res.status}`);
    const projects = (await res.json()) as Project[];
    const summary = projects.map((p) => ({
      name: p.name,
      status: p.status,
      live_status: p.live_status ?? null,
      live_exit_code: p.live_exit_code ?? null,
      live_checked_at: p.live_checked_at ?? null,
      live_error: p.live_error ?? null,
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
    description:
      "Get recent logs from a project's container. Annotates output with state: ok (container running), exited (container is stopped but Docker still has logs), no_container (project never started), or missing (container_id is set but Docker doesn't have it). Throws only on docker_error (Docker daemon 5xx / unreachable) so an operator can distinguish infrastructure failure from app silence — pre-#74 the tool returned empty logs for all of these.",
    inputSchema: z.object({
      project: z.string().describe("Project name or ID"),
      lines: z.number().optional().default(100).describe("Number of log lines to retrieve"),
    }),
  },
  async ({ project, lines }) => {
    const p = await resolveProject(project);
    const res = await apiGet(`/api/projects/${p.id}/logs?tail=${lines}`);
    // 502 = API surfaced a Docker daemon failure. Throw so the agent
    // gets a tool error, not silent empty logs.
    if (res.status === 502) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(`Docker error: ${data.error ?? "unknown"}`);
    }
    if (!res.ok) throw new Error(`Failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { logs: string; state?: string };
    switch (data.state) {
      case "no_container":
        return {
          content: [{ type: "text", text: "(project hasn't been started yet — no container)" }],
        };
      case "missing":
        return {
          content: [
            {
              type: "text",
              text: "(container_id was recorded but Docker doesn't have it; moor may need to recreate the project)",
            },
          ],
        };
      case "exited":
        return {
          content: [
            {
              type: "text",
              text: `${data.logs || "(no logs captured)"}\n\n(container is exited; logs above are from before)`,
            },
          ],
        };
      default:
        // "ok" or undefined (older API) — render raw.
        return {
          content: [{ type: "text", text: data.logs || "(no logs)" }],
        };
    }
  },
);

server.registerTool(
  "moor_rebuild",
  {
    title: "Rebuild Project",
    description:
      "Rebuild a project from source (git pull + docker build) and restart the container. Returns the build output when it finishes. While a build is in flight, the most recent moor_runs entry has finished_at=null — call moor_run_get on its id to tail the live output. Use moor_rebuild for code, Dockerfile, or base-image changes. For env vars / resource limits / port / volume / restart-policy changes, or to recover a crashed container from the existing image, use moor_restart — it skips the build and is much faster.",
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
    description:
      "Stop and recreate a project's container from its existing image. Does NOT pull from git or rebuild — uses the existing image_tag. Right tool for: applying changed env vars / resource limits / ports / volumes / restart policy, recovering a crashed container, or simply bouncing the process. Wrong tool for: code or Dockerfile changes (use moor_rebuild — those need a new image).",
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
    description:
      "Get server resource usage: load, memory, root disk, Docker disk by category (images/containers/volumes/build cache) with reclaimable bytes, and container counts. Note: cpu.percent is load-derived (load avg ÷ cores), not instantaneous CPU; use the `load` field for the same signal with explicit naming.",
  },
  async () => {
    const res = await apiGet("/api/server/stats");
    if (!res.ok) throw new Error(`Failed: ${res.status}`);
    const s = (await res.json()) as {
      hostname: string;
      os: string;
      uptime: string;
      cpu: { percent: number; cores: number };
      load?: { one_min: number; cores: number; normalized_percent: number };
      memory: { total: string; used: string; percent: number };
      disk: { total: string; used: string; percent: number };
      containers: { running: number; total: number };
      docker?: {
        images: { bytes: number; reclaimable_bytes: number; count: number; unused_count: number };
        containers: {
          bytes: number;
          reclaimable_bytes: number;
          count: number;
          stopped_count: number;
        };
        volumes: { bytes: number; reclaimable_bytes: number; count: number; unused_count: number };
        build_cache: { bytes: number; reclaimable_bytes: number; count: number };
      } | null;
    };
    const lines = [
      `Host: ${s.hostname}`,
      `OS: ${s.os}`,
      `Uptime: ${s.uptime}`,
      `CPU: ${s.cpu.percent}% (${s.cpu.cores} cores) — load-derived, not instantaneous`,
    ];
    if (s.load) {
      lines.push(
        `Load (1m): ${s.load.one_min.toFixed(2)} on ${s.load.cores} cores (${s.load.normalized_percent}%)`,
      );
    }
    lines.push(
      `Memory: ${s.memory.used} / ${s.memory.total} (${s.memory.percent}%)`,
      `Disk (root /): ${s.disk.used} / ${s.disk.total} (${s.disk.percent}%)`,
      `Containers: ${s.containers.running} running / ${s.containers.total} total`,
    );
    if (s.docker) {
      const d = s.docker;
      lines.push(
        "Docker disk:",
        `  Images: ${formatBytes(d.images.bytes)} (${formatBytes(d.images.reclaimable_bytes)} reclaimable, ${d.images.unused_count}/${d.images.count} unused)`,
        `  Containers: ${formatBytes(d.containers.bytes)} (${formatBytes(d.containers.reclaimable_bytes)} reclaimable, ${d.containers.stopped_count}/${d.containers.count} stopped)`,
        `  Volumes: ${formatBytes(d.volumes.bytes)} (${formatBytes(d.volumes.reclaimable_bytes)} reclaimable, ${d.volumes.unused_count}/${d.volumes.count} unused)`,
        `  Build cache: ${formatBytes(d.build_cache.bytes)} (${formatBytes(d.build_cache.reclaimable_bytes)} reclaimable, ${d.build_cache.count} entries)`,
      );
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

server.registerTool(
  "moor_update_status",
  {
    title: "Update status / preflight",
    description:
      "Report moor's current version + image digest, the latest available digest on GHCR, active in-flight work counts, DB backup recency, and a safe_to_update boolean. update_available is null (not false) when either the local repo_digest or the registry digest is unknown — never lies by comparing across identifier spaces. unsafe_reasons is a human-readable array; render inline rather than re-deriving from booleans. Read-only diagnostic — does NOT perform any update.",
  },
  async () => {
    const res = await apiGet("/api/server/update-status");
    if (!res.ok) throw new Error(`Failed: ${res.status} ${await res.text()}`);
    const s = (await res.json()) as {
      current: {
        version: string;
        image_id: string | null;
        repo_digest: string | null;
        started_at: string;
      };
      available: {
        latest_tag: string;
        latest_digest: string | null;
        update_available: boolean | null;
        registry_error: string | null;
      };
      active_work: {
        builds_in_flight: number;
        execs_in_flight: number;
        crons_in_flight: number;
        terminals_open: number;
      };
      db_backup: {
        last_backup_at: string | null;
        age_seconds: number | null;
        location: string | null;
      };
      safe_to_update: boolean;
      unsafe_reasons: string[];
      recommended_command: string;
    };
    const lines: string[] = [];
    lines.push(`moor ${s.current.version} (image_id: ${s.current.image_id ?? "unknown"})`);
    lines.push(
      `repo_digest: ${s.current.repo_digest ?? "(none — locally built or stale inspect)"}`,
    );

    if (s.available.update_available === true) {
      lines.push(`update AVAILABLE → latest: ${s.available.latest_digest}`);
    } else if (s.available.update_available === false) {
      lines.push(`up to date (latest: ${s.available.latest_digest})`);
    } else {
      // null — explain WHICH side is unknown.
      const why = s.available.registry_error
        ? `registry unreachable: ${s.available.registry_error}`
        : s.current.repo_digest === null
          ? "no local repo_digest (built locally?)"
          : "comparison unavailable";
      lines.push(`update availability unknown — ${why}`);
    }

    lines.push(
      `active: builds=${s.active_work.builds_in_flight} execs=${s.active_work.execs_in_flight} crons=${s.active_work.crons_in_flight} terminals=${s.active_work.terminals_open}`,
    );

    if (s.safe_to_update) {
      lines.push("safe_to_update: YES");
    } else {
      lines.push("safe_to_update: NO");
      for (const r of s.unsafe_reasons) lines.push(`  - ${r}`);
    }
    lines.push(`recommended: ${s.recommended_command}`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

// #79: drain mode. Operator-facing primitive that gates new work-against-
// container actions (deploys, builds, async/sync execs, manual cron
// triggers, terminal upgrades) so an upgrade can wait for in-flight work
// to complete cleanly. Drain refuses NEW work; it never kills in-flight
// work. The TTL is load-bearing — every refusal carries expires_at and
// the row auto-clears at expiry so a forgotten drain doesn't lock moor
// forever.

type DrainStateResponse = {
  state: {
    enabled: boolean;
    reason: string | null;
    started_at: string | null;
    expires_at: string | null;
    clear_after_version: string | null;
  };
};

type DrainStatusResponse = DrainStateResponse & {
  active_work: {
    builds_in_flight: number;
    execs_in_flight: number;
    crons_in_flight: number;
    terminals_open: number;
  };
};

function renderDrainState(s: DrainStateResponse["state"]): string[] {
  if (!s.enabled) return ["drain: OFF"];
  const lines = [`drain: ON (reason: ${s.reason ?? "(none)"})`];
  if (s.started_at) lines.push(`  started_at:  ${s.started_at}`);
  if (s.expires_at) lines.push(`  expires_at:  ${s.expires_at} (auto-clear)`);
  if (s.clear_after_version) {
    lines.push(
      `  clear_after_version: ${s.clear_after_version} (auto-clear on matching boot version)`,
    );
  }
  return lines;
}

server.registerTool(
  "moor_drain_status",
  {
    title: "Drain Status",
    description:
      "Read-only: current drain state (enabled, reason, expires_at, clear_after_version) plus counts of active work the operator should wait on before an update. active_work uses the same counter as moor_update_status so the two never disagree.",
  },
  async () => {
    const res = await apiGet("/api/server/drain");
    if (!res.ok) throw new Error(`drain status failed: ${res.status} ${await res.text()}`);
    const s = (await res.json()) as DrainStatusResponse;
    const lines = renderDrainState(s.state);
    lines.push(
      `active: builds=${s.active_work.builds_in_flight} execs=${s.active_work.execs_in_flight} crons=${s.active_work.crons_in_flight} terminals=${s.active_work.terminals_open}`,
    );
    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

server.registerTool(
  "moor_drain_enable",
  {
    title: "Enable Drain Mode",
    description:
      "Refuse new builds, deploys, execs, manual cron runs, and terminal upgrades with a 503 carrying { reason, expires_at, hint }. Existing in-flight work runs to completion — drain does NOT kill anything. Scheduled cron ticks during drain write a synthetic 'skipped due to drain' run row instead of executing. Read-only routes (status, logs, runs) keep working. Default TTL is 30 minutes; set ttl_minutes to override. clear_after_version is the updater's hook — when set, the drain auto-clears on boot if the running moor version matches.",
    inputSchema: z.object({
      reason: z
        .string()
        .optional()
        .describe(
          "Freeform reason shown in every refusal response (e.g. 'preparing for 0.34 upgrade').",
        ),
      ttl_minutes: z
        .number()
        .optional()
        .describe("Auto-clear after this many minutes. Default 30. Clamped to [0.05 min, 7 days]."),
      clear_after_version: z
        .string()
        .optional()
        .describe(
          "Optional: on next boot, if the running moor version equals this value, auto-clear the drain. Typically set by the updater path; safe for manual use too.",
        ),
    }),
  },
  async ({ reason, ttl_minutes, clear_after_version }) => {
    const res = await apiPost("/api/server/drain/enable", {
      reason,
      ttl_minutes,
      clear_after_version,
    });
    if (!res.ok) throw new Error(`drain enable failed: ${res.status} ${await res.text()}`);
    const s = (await res.json()) as DrainStateResponse;
    return { content: [{ type: "text", text: renderDrainState(s.state).join("\n") }] };
  },
);

server.registerTool(
  "moor_drain_disable",
  {
    title: "Disable Drain Mode",
    description:
      "Explicit operator action to clear drain immediately. Does not kill or restart anything — just removes the gate so new builds/deploys/execs/cron triggers/terminal upgrades succeed again.",
  },
  async () => {
    const res = await apiPost("/api/server/drain/disable", {});
    if (!res.ok) throw new Error(`drain disable failed: ${res.status} ${await res.text()}`);
    const s = (await res.json()) as DrainStateResponse;
    return { content: [{ type: "text", text: renderDrainState(s.state).join("\n") }] };
  },
);

// #90: operator-initiated DB snapshot. Uses VACUUM INTO on the server so
// hot WAL state is captured safely (cp would copy a corrupt-looking file).
// Backups land next to moor.db; retention prunes to the N most recent.
// Pair with MOOR_DB_BACKUP_INTERVAL_HOURS for scheduled snapshots — this
// tool is for taking one right before a manual update.
server.registerTool(
  "moor_db_backup",
  {
    title: "DB Backup (snapshot)",
    description:
      "Take a SQLite snapshot of moor.db via VACUUM INTO. The file lands next to the main DB as moor.db.backup-<epoch-ms>. Retention is enforced after each snapshot (keeps the 7 most recent by default; older ones are pruned). After this returns, moor_update_status' db_backup.age_seconds will read close to 0. Use before a manual `docker compose pull moor && up -d` if you don't have MOOR_DB_BACKUP_INTERVAL_HOURS scheduled.",
  },
  async () => {
    const res = await apiPost("/api/server/backup", {});
    if (!res.ok) throw new Error(`db backup failed: ${res.status} ${await res.text()}`);
    const r = (await res.json()) as { path: string; sizeBytes: number; durationMs: number };
    const mb = (r.sizeBytes / (1024 * 1024)).toFixed(2);
    return {
      content: [
        {
          type: "text",
          text: `Snapshot written: ${r.path}\nsize: ${r.sizeBytes}B (${mb} MB)\nduration: ${r.durationMs}ms`,
        },
      ],
    };
  },
);

// #80 PR #4: moor_update_apply — kick off a transient-respawner update of
// moor itself. The respawner runs async; this tool returns the audit_id
// immediately. Poll moor_update_status (or, eventually, moor_update_audit)
// for the outcome.
//
// IMPORTANT: PR #4 has no rollback. A failed compose-up / --wait timeout /
// health check writes a `failed` marker and exits; compose state is left
// as Compose left it. Recovery: manual `docker compose up`, OR wait for the
// 30-min stale-in_progress sweep to reclaim the audit row. Automatic
// rollback (retag + `--pull never`) lands in PR #5.
server.registerTool(
  "moor_update_apply",
  {
    title: "Apply moor update (transient respawner)",
    description:
      "Update moor in-place via a transient respawner container. Runs preflight, enables drain, takes a fresh DB backup, then launches a one-shot Compose-aware respawner that pulls + re-creates the moor service. The respawner writes a marker file when done; this tool returns the audit_id immediately so the caller can poll. PR #4 happy path ONLY — no automatic rollback. A failed up/health writes `failed` and leaves the compose state; recovery may require manual `docker compose up`. Bypass is per-blocker: pass {bypass:['active_work']} to interrupt in-flight builds/execs/crons via the existing shutdown coordinator; {bypass:['unknown_digest']} when the registry comparison was inconclusive. Backup is mandatory and not bypassable.",
    inputSchema: z.object({
      target_digest: z
        .string()
        .regex(/^sha256:[0-9a-f]{64}$/, "target_digest must be sha256:<64 hex>")
        .optional()
        .describe(
          "Pin the update to this exact image digest. Default: the registry's current `:latest` digest from moor_update_status.",
        ),
      bypass: z
        .array(z.enum(["active_work", "unknown_digest"]))
        .optional()
        .describe(
          "Per-blocker bypass. `active_work` accepts that in-flight builds/execs/crons will be interrupted via the shutdown coordinator. `unknown_digest` accepts proceeding when the registry comparison is inconclusive (locally-built image, GHCR unreachable). Backup is mandatory and not in this list.",
        ),
    }),
  },
  async (input) => {
    const res = await apiPost("/api/server/update/apply", input ?? {});
    if (res.status === 202) {
      const { audit_id } = (await res.json()) as { audit_id: number };
      return {
        content: [
          {
            type: "text",
            text: `Update started: audit_id=${audit_id}. Respawner is running async. Poll moor_update_status to watch the version change. Expected transitions: in_progress → success (clean apply) or → failed (compose/health failure; PR #4 has no rollback so the compose state is left where Compose left it). If the new moor never becomes healthy enough to ingest the marker, the audit row may stay in_progress until the 30-min stale sweep marks it crashed — at which point manual recovery (docker compose up) may be required.`,
          },
        ],
      };
    }
    // Error: surface the structured reason so callers can act on it.
    const body = (await res.json().catch(() => ({}))) as {
      error?: { code: string; reason?: string; unsafe_reasons?: string[] };
    };
    const code = body.error?.code ?? `HTTP ${res.status}`;
    const reason = body.error?.reason ?? "no detail";
    const extra = body.error?.unsafe_reasons
      ? `\nunsafe_reasons:\n  - ${body.error.unsafe_reasons.join("\n  - ")}`
      : "";
    throw new Error(`moor_update_apply refused [${code}]: ${reason}${extra}`);
  },
);

server.registerTool(
  "moor_cleanup_plan",
  {
    title: "Cleanup Plan (dry-run)",
    description:
      "Dry-run: list Docker resources that are safe to delete on this host. v1 covers build cache (host-wide prune) and dangling images (per-ID). Returns candidates with reclaimable bytes. Pass the same candidate list to moor_cleanup_execute to actually delete. No state is kept between plan and execute — execute re-validates eligibility against current Docker state.",
    inputSchema: z.object({
      scope: z
        .array(z.enum(["build_cache", "dangling_image"]))
        .optional()
        .describe("Subset of categories to plan. Defaults to all v1 categories."),
    }),
  },
  async ({ scope }) => {
    const res = await apiPost("/api/server/cleanup/plan", { scope });
    if (!res.ok) throw new Error(`plan failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as {
      candidates: Array<
        | { category: "build_cache"; reclaimable_bytes: number; label: string }
        | {
            category: "dangling_image";
            id: string;
            reclaimable_bytes: number;
            repo_tags: string[];
            label: string;
          }
      >;
      total_reclaimable_bytes: number;
    };
    if (data.candidates.length === 0) {
      return { content: [{ type: "text", text: "Nothing to clean up." }] };
    }
    const lines = [
      `${data.candidates.length} candidate(s), total reclaimable: ${formatBytes(data.total_reclaimable_bytes)}.`,
      "Pass the candidates_json block below back to moor_cleanup_execute to delete.",
      "",
    ];
    for (const c of data.candidates) {
      if (c.category === "build_cache") {
        lines.push(
          `build_cache [${c.label}] — ${formatBytes(c.reclaimable_bytes)} reclaimable (host-wide prune)`,
        );
      } else {
        const tags = c.repo_tags.length > 0 ? ` tags=${c.repo_tags.join(",")}` : "";
        lines.push(
          `dangling_image [${c.label}] id=${c.id} ${formatBytes(c.reclaimable_bytes)}${tags}`,
        );
      }
    }
    // Emit candidates_json so the agent doesn't have to reconstruct identifiers
    // from the prose lines above. The execute side ignores extra fields, so
    // passing the whole candidate objects (label, reclaimable_bytes, etc.) is
    // safe — server re-validates eligibility and computes actual freed bytes.
    lines.push("", "candidates_json:", JSON.stringify(data.candidates, null, 2));
    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

server.registerTool(
  "moor_cleanup_execute",
  {
    title: "Cleanup Execute",
    description:
      "Delete the candidates returned by moor_cleanup_plan. Server uses only the identifying fields (category + id where applicable) and re-validates eligibility against current Docker state immediately before each delete — Docker state can change between plan and execute. Reclaimable byte estimates from plan are ignored; the server reports the actual freed bytes. Every execute writes an audit row.",
    inputSchema: z.object({
      candidates: z
        .array(
          z.union([
            z.object({ category: z.literal("build_cache") }).passthrough(),
            z
              .object({ category: z.literal("dangling_image"), id: z.string().min(1) })
              .passthrough(),
          ]),
        )
        .min(1)
        .describe("Candidates from moor_cleanup_plan. Extra fields are ignored server-side."),
    }),
  },
  async ({ candidates }) => {
    const res = await apiPost("/api/server/cleanup/execute", { candidates });
    if (!res.ok) throw new Error(`execute failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as {
      audit_id: number;
      total_reclaimed_bytes: number;
      results: Array<
        | { category: "build_cache"; reclaimed_bytes: number; error: string | null }
        | {
            category: "dangling_image";
            id: string;
            reclaimed_bytes: number;
            error: string | null;
          }
      >;
    };
    const lines = [
      `audit_id=${data.audit_id} total_reclaimed=${formatBytes(data.total_reclaimed_bytes)}`,
      "",
    ];
    for (const r of data.results) {
      const status = r.error ? `ERROR: ${r.error}` : "ok";
      if (r.category === "build_cache") {
        lines.push(`build_cache: reclaimed=${formatBytes(r.reclaimed_bytes)} ${status}`);
      } else {
        lines.push(
          `dangling_image id=${r.id} reclaimed=${formatBytes(r.reclaimed_bytes)} ${status}`,
        );
      }
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

server.registerTool(
  "moor_project_stats",
  {
    title: "Project Container Stats (live)",
    description:
      "Live container stats for one project: CPU percent, memory (excluding page cache, same accounting as `docker stats`), network and block I/O totals, PID count. Single Docker stats snapshot — CPU uses the cpu_stats/precpu_stats delta the daemon already includes. Stopped or never-started projects return running=false with zeroed counters (no 404).",
    inputSchema: z.object({
      project: z.string().describe("Project name or ID"),
    }),
  },
  async ({ project }) => {
    const p = await resolveProject(project);
    const res = await apiGet(`/api/projects/${p.id}/container-stats`);
    if (!res.ok) throw new Error(`Failed: ${res.status} ${await res.text()}`);
    const s = (await res.json()) as {
      running: boolean;
      cpu_percent: number;
      memory_bytes: number;
      memory_limit_bytes: number;
      memory_percent: number;
      network_rx_bytes: number;
      network_tx_bytes: number;
      block_read_bytes: number;
      block_write_bytes: number;
      pids: number;
    };
    if (!s.running) {
      return {
        content: [{ type: "text", text: `${p.name}: not running (zeroed counters returned).` }],
      };
    }
    const memLimit = s.memory_limit_bytes > 0 ? formatBytes(s.memory_limit_bytes) : "unlimited";
    const lines = [
      `${p.name}: CPU ${s.cpu_percent}% | Memory ${formatBytes(s.memory_bytes)} / ${memLimit} (${s.memory_percent}%) | PIDs ${s.pids}`,
      `Network: rx ${formatBytes(s.network_rx_bytes)} / tx ${formatBytes(s.network_tx_bytes)}`,
      `Block I/O: read ${formatBytes(s.block_read_bytes)} / write ${formatBytes(s.block_write_bytes)}`,
    ];
    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const val = bytes / 1024 ** i;
  return `${val.toFixed(val < 10 ? 1 : 0)} ${units[i]}`;
}

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
        .min(0.001)
        .optional()
        .describe(
          "Max CPU cores. Fractional values OK (e.g. 0.5 = half a core). Min 0.001 (anything smaller rounds to Docker NanoCpus=0, which means unlimited — use omit for that). Max host core count. Takes effect on container recreate.",
        ),
      volumes: z
        .array(
          z.object({
            name: z.string().min(1).describe("Logical volume name (unique per project)"),
            target: z
              .string()
              .min(1)
              .describe("Absolute in-container mount path (e.g. /var/lib/postgresql/data)"),
          }),
        )
        .optional()
        .describe(
          "Named Docker volumes to attach. Each entry creates a per-project volume (stored as moor-<project>-<name>) and mounts it at the given target on next container recreate. Data survives container/project rebuilds unless explicitly purged via project delete with purge_volumes=true.",
        ),
    }),
  },
  async (input) => {
    const sources = (input.github_url ? 1 : 0) + (input.docker_image ? 1 : 0);
    if (sources !== 1) {
      throw new Error("Provide exactly one of github_url or docker_image");
    }
    if (input.github_url) validateGithubUrl(input.github_url);

    const { volumes, ...createBody } = input;
    const res = await apiPost("/api/projects", createBody);
    if (!res.ok) throw new Error(`Failed to create project: ${await res.text()}`);
    const project = (await res.json()) as { id: number };

    // Volumes are a separate endpoint so the API stays single-concern. Loop
    // through them; if any one fails, report what landed and what didn't.
    const volumeFailures: Array<{ name: string; error: string }> = [];
    const volumeCreated: string[] = [];
    if (volumes && volumes.length > 0) {
      for (const v of volumes) {
        const vRes = await apiPost(`/api/projects/${project.id}/volumes`, v);
        if (vRes.ok) volumeCreated.push(v.name);
        else volumeFailures.push({ name: v.name, error: await vRes.text() });
      }
    }

    const lines = [JSON.stringify(project, null, 2)];
    if (volumeCreated.length > 0) {
      lines.push(`\nCreated volumes: ${volumeCreated.join(", ")}`);
    }
    if (volumeFailures.length > 0) {
      lines.push(
        `\nVolume failures (project was still created): ${volumeFailures
          .map((f) => `${f.name}: ${f.error}`)
          .join("; ")}`,
      );
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
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
        .min(0.001)
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
      "Stops and removes the container, then deletes the project record. Requires confirm_name to match the resolved project name exactly. Irreversible. Named Docker volumes are preserved by default (data survives so a recreated project can remount them); pass purge_volumes: true to also delete the underlying Docker volumes — that deletion is also irreversible.",
    inputSchema: z.object({
      project: z.string().describe("Project name or ID to delete"),
      confirm_name: z
        .string()
        .describe(
          "Must equal the resolved project's name. Guards against deleting the wrong project.",
        ),
      purge_volumes: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Also delete the underlying Docker volumes (their data). Default false: project gone, volumes (and their data) preserved. The volume metadata is cleaned up either way; this flag only controls whether the data goes too.",
        ),
    }),
  },
  async ({ project, confirm_name, purge_volumes }) => {
    const p = await resolveProject(project);
    if (confirm_name !== p.name) {
      throw new Error(
        `confirm_name "${confirm_name}" does not match resolved project name "${p.name}". Refusing to delete.`,
      );
    }
    const qs = purge_volumes ? "?purge_volumes=true" : "";
    const res = await apiDelete(`/api/projects/${p.id}${qs}`);
    if (!res.ok) {
      const text = await res.text();
      try {
        const parsed = JSON.parse(text);
        if (parsed?.message) throw new Error(parsed.message);
      } catch {
        // not json
      }
      throw new Error(`Failed to delete project: ${text}`);
    }
    // 204 No Content (no purge or no volumes) vs 200 JSON (purge with results)
    if (res.status === 204) {
      return { content: [{ type: "text", text: `Deleted project ${p.name} (id=${p.id}).` }] };
    }
    const body = (await res.json()) as { volumes_purged?: number };
    return {
      content: [
        {
          type: "text",
          text: `Deleted project ${p.name} (id=${p.id}). Purged ${body.volumes_purged ?? 0} Docker volume(s).`,
        },
      ],
    };
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

// --- Volumes (#35) ---

server.registerTool(
  "moor_volume_list",
  {
    title: "List Project Volumes",
    description:
      "List the named Docker volumes attached to a project. Each entry includes the logical name (per-project handle), the in-container target path, and the actual Docker volume name (for `docker volume ls` / `docker volume inspect` outside moor).",
    inputSchema: z.object({
      project: z.string().describe("Project name or ID"),
    }),
  },
  async ({ project }) => {
    const p = await resolveProject(project);
    const res = await apiGet(`/api/projects/${p.id}/volumes`);
    if (!res.ok) throw new Error(`Failed: ${await res.text()}`);
    const rows = (await res.json()) as Array<{
      id: number;
      name: string;
      target: string;
      docker_name: string;
    }>;
    if (rows.length === 0) {
      return { content: [{ type: "text", text: `No volumes attached to ${p.name}.` }] };
    }
    const lines = rows.map(
      (v) => `id=${v.id}  name=${v.name}  target=${v.target}  docker_name=${v.docker_name}`,
    );
    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

server.registerTool(
  "moor_volume_add",
  {
    title: "Add Project Volume",
    description:
      "Attach a named Docker volume to a project. The volume is created lazily by Docker on first container start; moor stores the mount config (logical name, in-container target, and the generated docker_name like moor-<project>-<name>). Takes effect on container recreate (next moor_rebuild / moor_restart / moor_deploy / moor_project run) — already-running containers keep their existing mounts.",
    inputSchema: z.object({
      project: z.string().describe("Project name or ID"),
      name: z
        .string()
        .min(1)
        .describe("Logical volume name (unique per project; alphanumeric/_/-)"),
      target: z
        .string()
        .min(1)
        .describe("Absolute in-container mount path (e.g. /var/lib/postgresql/data)"),
    }),
  },
  async ({ project, name, target }) => {
    const p = await resolveProject(project);
    const res = await apiPost(`/api/projects/${p.id}/volumes`, { name, target });
    if (!res.ok) throw new Error(`Failed: ${await res.text()}`);
    const created = (await res.json()) as {
      id: number;
      name: string;
      target: string;
      docker_name: string;
    };
    return {
      content: [
        {
          type: "text",
          text: `Attached volume to ${p.name}: id=${created.id}, name=${created.name}, target=${created.target}, docker_name=${created.docker_name}. Mount applies on next container recreate.`,
        },
      ],
    };
  },
);

server.registerTool(
  "moor_volume_remove",
  {
    title: "Remove Project Volume Mount",
    description:
      "Detach a named volume from a project's mount config. The underlying Docker volume (and its data) is intentionally preserved — to actually delete the data, use moor_project_delete with purge_volumes:true, or run `docker volume rm <docker_name>` manually. Takes effect on next container recreate.",
    inputSchema: z.object({
      project: z.string().describe("Project name or ID"),
      volume_id: z.number().int().positive().describe("Volume ID from moor_volume_list"),
    }),
  },
  async ({ project, volume_id }) => {
    const p = await resolveProject(project);
    const res = await apiDelete(`/api/projects/${p.id}/volumes/${volume_id}`);
    if (res.status === 404) throw new Error(`Volume ${volume_id} not found on project ${p.name}`);
    if (!res.ok) throw new Error(`Failed: ${await res.text()}`);
    const body = (await res.json()) as { docker_name: string; message: string };
    return { content: [{ type: "text", text: body.message }] };
  },
);

// --- Runs history (#37) ---

// A runs row can be a cron run, a build/manual run, OR a cron run whose cron
// was deleted (cron_id was SET NULL by the FK). The list alone can't tell the
// latter two apart, so labels are honest about ambiguity instead of confidently
// calling NULL cron_id "build."
function deriveRunStatus(row: {
  finished_at: string | null;
  exit_code: number | null;
}): "running" | "success" | "failed" {
  if (!row.finished_at) return "running";
  return row.exit_code === 0 ? "success" : "failed";
}

function deriveRunType(row: { cron_id: number | null; cron_name: string | null }): string {
  if (row.cron_name) return `cron(${row.cron_name})`;
  // cron_id IS NULL — could be a genuine build/manual run, or a cron run
  // whose cron has since been deleted (ON DELETE SET NULL on the FK).
  return "build_or_manual";
}

function formatMsShort(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${s % 60}s`;
}

server.registerTool(
  "moor_runs",
  {
    title: "List Project Run History",
    description:
      "Paginated list of cron runs and build runs for a project. Returns one compact line per run (id, type, status, exit code, duration, output byte counts, timestamps) — stdout/stderr bodies are NOT included to avoid blowing token budgets on large build outputs. Use moor_run_get(run_id) to fetch the stored output for a single run (cron rows store full output; build/manual rows store at most a 64 KiB tail with the original total bytes recorded separately).",
    inputSchema: z.object({
      project: z.string().describe("Project name or ID"),
      page: z
        .number()
        .int()
        .positive()
        .optional()
        .default(1)
        .describe("Page number (20 runs per page). Default 1."),
    }),
  },
  async ({ project, page }) => {
    const p = await resolveProject(project);
    const res = await apiGet(`/api/projects/${p.id}/runs?include_output=false&page=${page}`);
    if (!res.ok) throw new Error(`Failed: ${await res.text()}`);
    const data = (await res.json()) as {
      runs: Array<{
        id: number;
        cron_id: number | null;
        cron_name: string | null;
        cron_command: string | null;
        started_at: string;
        finished_at: string | null;
        exit_code: number | null;
        duration_ms: number | null;
        stdout_bytes: number;
        stderr_bytes: number;
        stdout_total_bytes?: number;
        stderr_total_bytes?: number;
      }>;
      total: number;
    };
    if (data.runs.length === 0) {
      return {
        content: [{ type: "text", text: `No runs recorded for ${p.name}.` }],
      };
    }
    const lines: string[] = [];
    lines.push(
      `${p.name}: ${data.runs.length} run(s) on page ${page}, ${data.total} total. Use moor_run_get(run_id) for stored output (build/manual rows are tail-truncated; total bytes shown below).`,
    );
    for (const r of data.runs) {
      const type = deriveRunType(r);
      const status = deriveRunStatus(r);
      const exit = r.exit_code != null ? ` exit=${r.exit_code}` : "";
      const cmd = r.cron_command ? ` cmd="${r.cron_command}"` : "";
      // #65: surface "what was emitted" (total) per byte field. For live or
      // already-truncated build runs total > stored; for crons and historical
      // build rows they're equal. Showing total is the operationally useful
      // number — "what did Docker actually produce" — and stays accurate as a
      // build streams in. Fall back to stdout_bytes if the API is old.
      const outTotal = r.stdout_total_bytes ?? r.stdout_bytes;
      const errTotal = r.stderr_total_bytes ?? r.stderr_bytes;
      lines.push(
        `id=${r.id} ${type} ${status}${exit} dur=${formatMsShort(r.duration_ms)} stdout=${outTotal}B stderr=${errTotal}B started=${r.started_at}${cmd}`,
      );
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

server.registerTool(
  "moor_run_get",
  {
    title: "Get Run Detail",
    description:
      "Fetch one cron or build run with its stdout and stderr. Output is tail-truncated (default 8 KiB per stream; max 65536) to keep responses under typical agent token limits. Use tail_bytes=0 for metadata-only.",
    inputSchema: z.object({
      run_id: z.number().int().positive().describe("Run ID returned by moor_runs"),
      tail_bytes: z
        .number()
        .int()
        .min(0)
        .max(65_536)
        .optional()
        .describe(
          "Max bytes of each stream returned inline. Default 8192. Max 65536. Set to 0 for metadata-only.",
        ),
    }),
  },
  async ({ run_id, tail_bytes }) => {
    const cap = tail_bytes ?? 8192;
    const res = await apiGet(`/api/runs/${run_id}`);
    if (res.status === 404) throw new Error(`run_id ${run_id} not found`);
    if (!res.ok) throw new Error(`Failed: ${await res.text()}`);
    const r = (await res.json()) as {
      id: number;
      cron_id: number | null;
      cron_name: string | null;
      cron_command: string | null;
      started_at: string;
      finished_at: string | null;
      exit_code: number | null;
      duration_ms: number | null;
      stdout: string | null;
      stderr: string | null;
      stdout_total_bytes?: number | null;
      stderr_total_bytes?: number | null;
    };
    const lines: string[] = [];
    const type = deriveRunType(r);
    const status = deriveRunStatus(r);
    const exit = r.exit_code != null ? ` exit_code=${r.exit_code}` : "";
    lines.push(`run_id=${r.id} ${type} ${status}${exit} duration=${formatMsShort(r.duration_ms)}`);
    if (r.cron_command) lines.push(`cron_command: ${r.cron_command}`);
    lines.push(`started_at: ${r.started_at}`);
    if (r.finished_at) lines.push(`finished_at: ${r.finished_at}`);
    // #65: runs.stdout/stderr for build runs is a server-side 64 KiB tail
    // (TAIL_CAP_BYTES). Use stdout_total_bytes / stderr_total_bytes when the
    // API provides them so appendStream can honestly report "last X of Y".
    // For cron rows the stored payload IS the full output, and total == stored.
    // Fall back to encoded length for older APIs that don't return the totals.
    const stdoutStr = r.stdout ?? "";
    const stderrStr = r.stderr ?? "";
    const enc = new TextEncoder();
    const stdoutTotal = r.stdout_total_bytes ?? enc.encode(stdoutStr).length;
    const stderrTotal = r.stderr_total_bytes ?? enc.encode(stderrStr).length;
    appendStream(lines, "stdout", stdoutStr, stdoutTotal, cap);
    appendStream(lines, "stderr", stderrStr, stderrTotal, cap);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

server.registerTool(
  "moor_run_stop",
  {
    title: "Stop or Cancel a Run",
    description:
      "Stops an active cron run or cancels an active build/pull run (from moor_rebuild / moor_deploy). Closing the connection to the Docker build/pull endpoint aborts the daemon-side job. Cancellation is only valid during the build/pull streaming phase — once the build finishes and container start has begun, the call returns not_cancellable. Returns one of: cancelled, cancelled_cron, not_cancellable, already_finished, not_active, not_found. These are all expected outcomes, not errors — the tool throws only on unexpected server failures.",
    inputSchema: z.object({
      run_id: z.number().int().positive().describe("Run ID from moor_runs"),
    }),
  },
  async ({ run_id }) => {
    const res = await apiPost(`/api/runs/${run_id}/stop`);
    // The /stop route returns 200 for cancelled/cancelled_cron and 4xx
    // for the rest of the known result categories (with a result field
    // either way). All of those are expected outcomes — render them as
    // content so the agent can react without try/catch. Only surface as
    // an error if the response doesn't fit the documented shape (server
    // error, parse failure, etc).
    let data: { ok?: boolean; result?: string; error?: string };
    try {
      data = (await res.json()) as { ok?: boolean; result?: string; error?: string };
    } catch {
      throw new Error(`run_id=${run_id} server error: ${res.status} ${res.statusText}`);
    }
    if (typeof data.result === "string") {
      return { content: [{ type: "text", text: `run_id=${run_id} ${data.result}` }] };
    }
    throw new Error(
      `run_id=${run_id} unexpected response: status=${res.status} body=${JSON.stringify(data)}`,
    );
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
        .min(0.001)
        .nullable()
        .optional()
        .describe(
          "Max CPU cores. Fractional OK (e.g. 0.5; min 0.001). Max host core count. Pass null on update to clear.",
        ),
      volumes: z
        .array(
          z.object({
            name: z.string().min(1),
            target: z.string().min(1),
          }),
        )
        .optional()
        .describe(
          "Named Docker volumes to attach. Each entry becomes a per-project volume (stored as moor-<project>-<name>) and mounts at the given target on container recreate. On update_existing, additions only — no removals. Data survives container/project rebuilds unless explicitly purged via moor_project_delete with confirm_name (purge_volumes is a separate flag).",
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

    // #79: drain-mode preflight. moor_deploy is a composition: by the
    // time the run step (Step 3) hits the drain 503 from /api/projects/
    // :id/run, the create/update/volume/env side effects have already
    // landed. Check drain server-side BEFORE any writes so a drained
    // deploy fails cleanly without leaving partial state.
    //
    // Skipped when run: false because the no-run mode is metadata-only —
    // no container work, so drain doesn't apply.
    if (input.run !== false) {
      const drainRes = await apiGet("/api/server/drain");
      if (drainRes.ok) {
        const { state } = (await drainRes.json()) as {
          state: { enabled: boolean; reason: string | null; expires_at: string | null };
        };
        if (state.enabled) {
          throw new Error(
            `[drain] moor is draining (reason: ${state.reason ?? "(none)"}; expires_at: ${state.expires_at}). Refusing deploy before any project create/update side effects. Use moor_drain_disable to re-enable, or retry after expiry. Pass run: false if you only need metadata changes.`,
          );
        }
      }
      // If the drain endpoint is unreachable (older moor or transient
      // failure), don't block the deploy — the per-route gate inside
      // /api/projects/:id/run will still catch it before container work
      // starts. Preflight is an optimization, not the guarantee.
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

    // Step 1.5: add named volumes (additions only — moor_deploy never removes
    // volumes, even on update_existing). Mounts apply on next container
    // recreate, which the run step below triggers by default.
    if (input.volumes && input.volumes.length > 0) {
      // Cache the existing list once so we can resolve 409s without re-fetching
      // per conflict. Only fetched if a 409 actually occurs.
      let existingVolumes: Array<{ name: string; target: string }> | null = null;
      for (const v of input.volumes) {
        const vRes = await apiPost(`/api/projects/${projectId}/volumes`, v);
        if (vRes.ok) continue;
        const text = await vRes.text();
        if (vRes.status !== 409) {
          throw new Error(`[volumes] failed to add ${v.name}: ${text}`);
        }
        // 409 is tolerable ONLY if the existing volume matches the requested
        // spec exactly (same name, same target). A 409 with a drifted target
        // means the operator changed the desired mount and we'd silently
        // ignore the change — fail loudly instead.
        if (existingVolumes === null) {
          const listRes = await apiGet(`/api/projects/${projectId}/volumes`);
          if (!listRes.ok) {
            throw new Error(
              `[volumes] could not resolve 409 on ${v.name}: failed to list existing volumes: ${await listRes.text()}`,
            );
          }
          existingVolumes = (await listRes.json()) as Array<{ name: string; target: string }>;
        }
        const match = existingVolumes.find((e) => e.name === v.name);
        if (!match) {
          // 409 was for some other reason (target collision under a different
          // name, or cross-project docker_name collision). Operator must
          // intervene.
          throw new Error(
            `[volumes] conflict adding ${v.name}: ${text} (no existing volume by that name; check for target collision)`,
          );
        }
        if (match.target !== v.target) {
          throw new Error(
            `[volumes] conflict adding ${v.name}: existing target "${match.target}" differs from requested "${v.target}". moor_deploy does not change mount targets; use moor_volume_remove + moor_volume_add explicitly.`,
          );
        }
        // Same name, same target — idempotent re-run, tolerable.
      }
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
