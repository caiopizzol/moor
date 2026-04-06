import { McpServer, StdioServerTransport } from "@modelcontextprotocol/server";
import { z } from "zod";

// --- Config ---

const baseUrl = (process.env.MOOR_URL || "").replace(/\/$/, "");
const apiKey = process.env.MOOR_API_KEY || "";

if (!baseUrl || !apiKey) {
  console.error("MOOR_URL and MOOR_API_KEY environment variables are required");
  process.exit(1);
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
    description: "Run a shell command inside a project's running container.",
    inputSchema: z.object({
      project: z.string().describe("Project name or ID"),
      command: z.string().describe("Shell command to execute"),
    }),
  },
  async ({ project, command }) => {
    const p = await resolveProject(project);
    const res = await apiPost(`/api/projects/${p.id}/exec`, { command });
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

// --- Start ---

const transport = new StdioServerTransport();
await server.connect(transport);
