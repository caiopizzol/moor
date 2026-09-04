#!/usr/bin/env bun
import { McpServer, StdioServerTransport } from "@modelcontextprotocol/server";
import {
  createMoorApiClient,
  type FetchLike,
  type MoorApiClient,
  type Project,
  parseErrorMessage,
} from "../../contract/src/index";
import { readSSE } from "./sse";
import { registerCleanupTools } from "./tools/cleanup";
import { registerCredentialTools } from "./tools/credentials";
import { registerEnvTools } from "./tools/env";
import { registerExecTools } from "./tools/exec";
import { registerProjectTools } from "./tools/projects";
import { registerRunTools } from "./tools/runs";
import { registerServerTools } from "./tools/server";
import { registerUpdateTools } from "./tools/update";

// --- Config ---

const config = {
  baseUrl: (process.env.MOOR_URL || "").replace(/\/$/, ""),
  apiKey: process.env.MOOR_API_KEY || "",
};

if (!config.baseUrl || !config.apiKey) {
  console.error("MOOR_URL and MOOR_API_KEY environment variables are required");
  process.exit(1);
}

async function rawResponseRequest(
  callClient: (client: MoorApiClient) => Promise<unknown>,
): Promise<Response> {
  let rawResponse: Response | undefined;
  const fetchRawResponse: FetchLike = async (input, init) => {
    rawResponse = await globalThis.fetch(input, init);
    return new Response(null, { status: 204 });
  };
  const client = createMoorApiClient({
    ...config,
    fetch: fetchRawResponse,
  });

  await callClient(client);
  if (!rawResponse) throw new Error("No response received");
  return rawResponse;
}

// --- Startup probe ---
// Fail closed: verify URL is reachable AND the bearer token authenticates before
// registering tools. Misconfigs surface here with a clear stderr message instead
// of later as opaque tool-call failures inside the MCP client.
{
  let probeRes: Response;
  try {
    probeRes = await rawResponseRequest((client) =>
      client.get("/api/projects", { signal: AbortSignal.timeout(5000) }),
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`Cannot reach moor at ${config.baseUrl}: ${msg}`);
    console.error("Check MOOR_URL and that moor is running (and tunneled, if remote).");
    process.exit(1);
  }
  if (probeRes.status === 401) {
    console.error(`Authentication failed against ${config.baseUrl}.`);
    console.error("Check MOOR_API_KEY matches the value in moor's .env on the server.");
    process.exit(1);
  }
  if (probeRes.status === 503) {
    console.error(`moor at ${config.baseUrl} returned 503.`);
    console.error("Likely cause: MOOR_INITIAL_PASSWORD not configured. Set it and restart moor.");
    process.exit(1);
  }
  if (!probeRes.ok) {
    console.error(`moor at ${config.baseUrl} returned ${probeRes.status} on startup probe.`);
    process.exit(1);
  }
}

// --- HTTP client ---

const apiResponse = {
  get: (path: string) => rawResponseRequest((client) => client.get(path)),
  post: (path: string, body?: unknown) => rawResponseRequest((client) => client.post(path, body)),
  put: (path: string, body: unknown) => rawResponseRequest((client) => client.put(path, body)),
  delete: (path: string) => rawResponseRequest((client) => client.delete(path)),
};

async function readErrorMessage(res: Response): Promise<string> {
  const text = await res.text();
  return parseErrorMessage(text, res.status);
}

async function resolveProject(name: string): Promise<Project> {
  const res = await apiResponse.get("/api/projects");
  if (!res.ok) throw new Error(`Failed to list projects: ${res.status}`);
  const projects = (await res.json()) as Project[];
  const match = projects.find((p) => p.name === name || String(p.id) === name);
  if (!match) throw new Error(`Project "${name}" not found`);
  return match;
}

// --- MCP Server ---

const server = new McpServer({
  name: "moor",
  version: "0.1.0",
});

// --- Tools ---

const client = { apiResponse, resolveProject, readErrorMessage, readSSE };

registerProjectTools(server, client);
registerRunTools(server, client);
registerExecTools(server, client);
registerEnvTools(server, client);
registerCredentialTools(server, client);
registerServerTools(server, client);
registerUpdateTools(server, client);
registerCleanupTools(server, client);

// --- Start ---

const transport = new StdioServerTransport();
await server.connect(transport);
