import { describe, expect, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/server";
import type { Project } from "../../../contract/src/index";
import { registerCleanupTools } from "./cleanup";
import type { SseReadResult, ToolContext } from "./context";
import { registerCredentialTools } from "./credentials";
import { registerEnvTools } from "./env";
import { registerExecTools } from "./exec";
import { registerProjectTools } from "./projects";
import { registerRunTools } from "./runs";
import { registerServerTools } from "./server";
import { registerUpdateTools } from "./update";

type Registrar = (server: McpServer, client: ToolContext) => void;
type ToolHandler = (input: unknown) => unknown | Promise<unknown>;
type ToolDefinition = {
  inputSchema?: unknown;
  handler: ToolHandler;
};
type SafeParseResult =
  | { success: true; data: unknown }
  | { success: false; error: { issues?: Array<{ message: string }>; message: string } };
type SafeParsable = {
  safeParse(input: unknown): SafeParseResult;
};
type ApiMethod = "GET" | "POST" | "PUT" | "DELETE";
type ApiCall = {
  method: ApiMethod;
  path: string;
  body?: unknown;
};
type ApiResponder = (body: unknown) => Response | Promise<Response>;

class TestMcpServer {
  readonly tools = new Map<string, ToolDefinition>();

  registerTool(name: string, config: { inputSchema?: unknown }, handler: ToolHandler): void {
    this.tools.set(name, {
      inputSchema: config.inputSchema,
      handler,
    });
  }

  async call(name: string, input: Record<string, unknown> = {}): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Tool not registered: ${name}`);
    const parsed = parseInput(tool.inputSchema, input);
    return await tool.handler(parsed);
  }
}

class MockApi {
  readonly calls: ApiCall[] = [];
  private readonly responders = new Map<string, ApiResponder>();

  readonly apiResponse: ToolContext["apiResponse"] = {
    get: (path) => this.request("GET", path),
    post: (path, body) => this.request("POST", path, body),
    put: (path, body) => this.request("PUT", path, body),
    delete: (path) => this.request("DELETE", path),
  };

  on(method: ApiMethod, path: string, responder: ApiResponder): void {
    this.responders.set(routeKey(method, path), responder);
  }

  async request(method: ApiMethod, path: string, body?: unknown): Promise<Response> {
    this.calls.push(body === undefined ? { method, path } : { method, path, body });
    const responder = this.responders.get(routeKey(method, path));
    if (!responder) throw new Error(`No mock response for ${method} ${path}`);
    return await responder(body);
  }
}

function routeKey(method: ApiMethod, path: string): string {
  return `${method} ${path}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeParsable(value: unknown): value is SafeParsable {
  return isRecord(value) && typeof value.safeParse === "function";
}

function parseInput(schema: unknown, input: unknown): unknown {
  if (schema === undefined) return input;
  if (!isSafeParsable(schema)) throw new Error("Unsupported tool input schema in test");
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issueText = result.error.issues?.map((issue) => issue.message).join("; ");
  throw new Error(issueText || result.error.message);
}

function json(body: unknown, init?: ResponseInit): Response {
  return Response.json(body, init);
}

function errorJson(message: string, status = 400): Response {
  return json({ error: message }, { status });
}

function noContent(): Response {
  return new Response(null, { status: 204 });
}

async function readErrorMessage(res: Response): Promise<string> {
  const text = await res.text();
  if (!text) return `HTTP ${res.status}`;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (isRecord(parsed) && "error" in parsed) {
      const error = parsed.error;
      return typeof error === "string" ? error : JSON.stringify(error);
    }
  } catch {
    return text;
  }
  return text;
}

function projectFixture(overrides: Partial<Project> = {}): Project {
  return {
    id: 7,
    name: "app",
    github_url: "https://github.com/owner/app",
    docker_image: null,
    branch: "main",
    dockerfile: "Dockerfile",
    image_tag: "moor-app:latest",
    container_id: "abc123",
    status: "running",
    domain: "app.example.com",
    domain_port: 3000,
    restart_policy: "unless-stopped",
    memory_limit_mb: null,
    cpus: null,
    source_credential_id: null,
    command: null,
    entrypoint: null,
    live_status: "running",
    live_exit_code: null,
    live_checked_at: "2026-07-06T12:00:00Z",
    live_error: null,
    created_at: "2026-07-06T11:00:00Z",
    ...overrides,
  };
}

function createHarness(
  register: Registrar,
  options: {
    projects?: Project[];
    resolveError?: Error;
    sse?: SseReadResult;
  } = {},
): { api: MockApi; server: TestMcpServer; setSse(result: SseReadResult): void } {
  const api = new MockApi();
  const server = new TestMcpServer();
  const projects = options.projects ?? [projectFixture()];
  let sseResult = options.sse ?? { logs: "" };

  const client: ToolContext = {
    apiResponse: api.apiResponse,
    resolveProject: async (name) => {
      if (options.resolveError) throw options.resolveError;
      const match = projects.find((p) => p.name === name || String(p.id) === name);
      if (!match) throw new Error(`Project "${name}" not found`);
      return match;
    },
    readErrorMessage,
    readSSE: async () => sseResult,
  };

  register(server as unknown as McpServer, client);
  return {
    api,
    server,
    setSse(result) {
      sseResult = result;
    },
  };
}

function toolText(result: unknown): string {
  if (!isRecord(result) || !Array.isArray(result.content)) {
    throw new Error("Tool result did not include content");
  }
  const first = result.content[0];
  if (!isRecord(first) || first.type !== "text" || typeof first.text !== "string") {
    throw new Error("Tool result did not include text content");
  }
  return first.text;
}

function isErrorResult(result: unknown): boolean {
  return isRecord(result) && result.isError === true;
}

function structuredContent(result: unknown): unknown {
  if (!isRecord(result)) return undefined;
  return result.structuredContent;
}

describe("project tools", () => {
  test("moor_status renders a compact project list", async () => {
    const { api, server } = createHarness(registerProjectTools);
    api.on("GET", "/api/projects", () =>
      json([
        projectFixture({
          name: "app",
          docker_image: "ghcr.io/acme/app:latest",
          github_url: null,
          live_status: "error",
          live_exit_code: 137,
          live_error: "container missing",
        }),
      ]),
    );

    const result = await server.call("moor_status");
    const summary = JSON.parse(toolText(result)) as Array<Record<string, unknown>>;

    expect(summary).toEqual([
      {
        name: "app",
        status: "running",
        live_status: "error",
        live_exit_code: 137,
        live_checked_at: "2026-07-06T12:00:00Z",
        live_error: "container missing",
        source: "ghcr.io/acme/app:latest",
        domain: "app.example.com",
      },
    ]);
  });

  test("project create validates names before making API calls", async () => {
    const { api, server } = createHarness(registerProjectTools);

    await expect(
      server.call("moor_project_create", { name: "-bad", docker_image: "nginx:alpine" }),
    ).rejects.toThrow("name must start with an alphanumeric character");
    expect(api.calls).toHaveLength(0);
  });

  test("project create requires exactly one source", async () => {
    const { api, server } = createHarness(registerProjectTools);

    await expect(server.call("moor_project_create", { name: "app" })).rejects.toThrow(
      "Provide exactly one of github_url or docker_image",
    );
    expect(api.calls).toHaveLength(0);
  });

  test("project create shapes volume input into separate API calls", async () => {
    const { api, server } = createHarness(registerProjectTools);
    api.on("POST", "/api/projects", () => json({ id: 10, name: "app" }, { status: 201 }));
    api.on("POST", "/api/projects/10/volumes", () =>
      json({ id: 2, name: "data", target: "/data", docker_name: "moor-app-data" }, { status: 201 }),
    );

    const result = await server.call("moor_project_create", {
      name: "app",
      docker_image: "nginx:alpine",
      volumes: [{ name: "data", target: "/data" }],
    });

    expect(api.calls).toEqual([
      {
        method: "POST",
        path: "/api/projects",
        body: { name: "app", docker_image: "nginx:alpine" },
      },
      {
        method: "POST",
        path: "/api/projects/10/volumes",
        body: { name: "data", target: "/data" },
      },
    ]);
    expect(toolText(result)).toContain("Created volumes: data");
  });

  test("moor_deploy rejects non-repo GitHub URLs before side effects", async () => {
    const { api, server } = createHarness(registerProjectTools);

    await expect(
      server.call("moor_deploy", {
        name: "app",
        github_url: "https://github.com/owner/repo/tree/main",
      }),
    ).rejects.toThrow("github_url must point to /owner/repo");
    expect(api.calls).toHaveLength(0);
  });

  test("moor_deploy normalizes domains and surfaces create errors from JSON", async () => {
    const { api, server } = createHarness(registerProjectTools, { projects: [] });
    api.on("GET", "/api/server/drain", () =>
      json({ state: { enabled: false, reason: null, expires_at: null } }),
    );
    api.on("GET", "/api/projects", () => json([]));
    api.on("POST", "/api/projects", () => errorJson("domain already routed", 409));

    await expect(
      server.call("moor_deploy", {
        name: "app",
        docker_image: "nginx:alpine",
        domain: " App.Example.COM ",
      }),
    ).rejects.toThrow("[create] domain already routed");

    expect(
      api.calls.find((call) => call.path === "/api/projects" && call.method === "POST"),
    ).toEqual({
      method: "POST",
      path: "/api/projects",
      body: {
        name: "app",
        github_url: undefined,
        docker_image: "nginx:alpine",
        branch: undefined,
        dockerfile: undefined,
        domain: "app.example.com",
        domain_port: undefined,
        restart_policy: undefined,
        memory_limit_mb: undefined,
        cpus: undefined,
        source_credential_id: undefined,
        command: undefined,
        entrypoint: undefined,
      },
    });
  });

  test("moor_deploy renders create plus run output", async () => {
    const { api, server, setSse } = createHarness(registerProjectTools, { projects: [] });
    setSse({ logs: "pull complete\nstarted\n" });
    api.on("GET", "/api/server/drain", () =>
      json({ state: { enabled: false, reason: null, expires_at: null } }),
    );
    api.on("GET", "/api/projects", () => json([]));
    api.on("POST", "/api/projects", () =>
      json(
        projectFixture({ id: 10, name: "app", docker_image: "nginx:alpine", github_url: null }),
        {
          status: 201,
        },
      ),
    );
    api.on("POST", "/api/projects/10/run", () => new Response("event: done\n"));

    const result = await server.call("moor_deploy", {
      name: "app",
      docker_image: "nginx:alpine",
    });

    expect(toolText(result)).toBe(
      "Created project app (id=10).\n\nBuild/run output:\npull complete\nstarted\n",
    );
  });
});

describe("run and log tools", () => {
  test("moor_logs distinguishes projects with no container", async () => {
    const { api, server } = createHarness(registerRunTools);
    api.on("GET", "/api/projects/7/logs?tail=100", () => json({ logs: "", state: "no_container" }));

    const result = await server.call("moor_logs", { project: "app" });

    expect(toolText(result)).toBe("(project hasn't been started yet \u2014 no container)");
  });

  test("moor_logs surfaces API error JSON and Docker 502 details", async () => {
    const { api, server } = createHarness(registerRunTools);
    api.on("GET", "/api/projects/7/logs?tail=25", () => errorJson("container inspect failed", 500));
    api.on("GET", "/api/projects/7/logs?tail=50", () => errorJson("daemon unavailable", 502));

    await expect(server.call("moor_logs", { project: "app", lines: 25 })).rejects.toThrow(
      "Failed: 500 container inspect failed",
    );
    await expect(server.call("moor_logs", { project: "app", lines: 50 })).rejects.toThrow(
      "Docker error: daemon unavailable",
    );
  });

  test("moor_rebuild surfaces pre-stream run errors", async () => {
    const { api, server } = createHarness(registerRunTools);
    api.on("POST", "/api/projects/7/run?nocache=true", () => errorJson("drain mode active", 503));

    await expect(server.call("moor_rebuild", { project: "app", no_cache: true })).rejects.toThrow(
      "[run] drain mode active",
    );
  });

  test("moor_rebuild returns structured build failures as tool errors", async () => {
    const { api, server, setSse } = createHarness(registerRunTools);
    setSse({
      logs: "clone failed\n",
      structuredError: {
        code: "source_credential_required",
        message: "private repo requires a credential",
      },
    });
    api.on("POST", "/api/projects/7/run", () => new Response("event: log\n"));

    const result = await server.call("moor_rebuild", { project: "app" });

    expect(isErrorResult(result)).toBe(true);
    expect(toolText(result)).toBe(
      "rebuild failed: code=source_credential_required message=private repo requires a credential",
    );
    expect(structuredContent(result)).toEqual({
      code: "source_credential_required",
      message: "private repo requires a credential",
    });
  });

  test("moor_runs renders compact run list rows", async () => {
    const { api, server } = createHarness(registerRunTools);
    api.on("GET", "/api/projects/7/runs?include_output=false&page=2", () =>
      json({
        total: 22,
        runs: [
          {
            id: 55,
            cron_id: 3,
            cron_name: "nightly",
            cron_command: "bun run job",
            started_at: "2026-07-06T12:00:00Z",
            finished_at: null,
            exit_code: null,
            duration_ms: null,
            stdout_bytes: 10,
            stderr_bytes: 0,
            stdout_total_bytes: 4096,
            stderr_total_bytes: 0,
          },
          {
            id: 54,
            cron_id: null,
            cron_name: null,
            cron_command: null,
            started_at: "2026-07-06T11:00:00Z",
            finished_at: "2026-07-06T11:01:05Z",
            exit_code: 1,
            duration_ms: 65_000,
            stdout_bytes: 4,
            stderr_bytes: 9,
          },
        ],
      }),
    );

    const result = await server.call("moor_runs", { project: "app", page: 2 });

    expect(toolText(result)).toBe(
      [
        "app: 2 run(s) on page 2, 22 total. Use moor_run_get(run_id) for stored output (build/manual rows are tail-truncated; total bytes shown below).",
        'id=55 cron(nightly) running dur=\u2014 stdout=4096B stderr=0B started=2026-07-06T12:00:00Z cmd="bun run job"',
        "id=54 build_or_manual failed exit=1 dur=1m5s stdout=4B stderr=9B started=2026-07-06T11:00:00Z",
      ].join("\n"),
    );
  });

  test("moor_run_get renders detail metadata and tail-truncated streams", async () => {
    const { api, server } = createHarness(registerRunTools);
    api.on("GET", "/api/runs/55", () =>
      json({
        id: 55,
        cron_id: null,
        cron_name: null,
        cron_command: null,
        started_at: "2026-07-06T12:00:00Z",
        finished_at: "2026-07-06T12:00:03Z",
        exit_code: 0,
        duration_ms: 3000,
        stdout: "0123456789",
        stderr: "abc",
        stdout_total_bytes: 20,
        stderr_total_bytes: 3,
      }),
    );

    const result = await server.call("moor_run_get", { run_id: 55, tail_bytes: 4 });
    const text = toolText(result);

    expect(text).toContain("run_id=55 build_or_manual success exit_code=0 duration=3s");
    expect(text).toContain("started_at: 2026-07-06T12:00:00Z");
    expect(text).toContain(
      "stdout (showing last 4 chars of 10 stored bytes; 20 total bytes seen):\n6789",
    );
    expect(text).toContain("stderr:\nabc");
  });
});

describe("exec tools", () => {
  test("moor_exec requires a command", async () => {
    const { server } = createHarness(registerExecTools);

    await expect(server.call("moor_exec", { project: "app" })).rejects.toThrow("expected string");
  });

  test("moor_exec sends timeout_ms only when provided and formats output", async () => {
    const { api, server } = createHarness(registerExecTools);
    api.on("POST", "/api/projects/7/exec", () =>
      json({ exitCode: 2, stdout: "out\n", stderr: "err\n" }),
    );

    const result = await server.call("moor_exec", {
      project: "app",
      command: "false",
      timeout_ms: 2000,
    });

    expect(api.calls[0]).toEqual({
      method: "POST",
      path: "/api/projects/7/exec",
      body: { command: "false", timeout_ms: 2000 },
    });
    expect(toolText(result)).toBe("out\n\n[stderr] err\n\n[exit code: 2]");
  });

  test("moor_exec surfaces API error JSON and timeout kill details", async () => {
    const { api, server } = createHarness(registerExecTools);
    api.on("POST", "/api/projects/7/exec", (body) => {
      if (isRecord(body) && body.command === "sleep 10") {
        return json(
          {
            timeout_ms: 1000,
            killed: true,
            killed_pid: "42",
            live_remaining: 0,
            message: "timed out",
          },
          { status: 504 },
        );
      }
      return errorJson("container is not running", 409);
    });

    await expect(server.call("moor_exec", { project: "app", command: "pwd" })).rejects.toThrow(
      "Failed: container is not running",
    );
    await expect(
      server.call("moor_exec", { project: "app", command: "sleep 10", timeout_ms: 1000 }),
    ).rejects.toThrow("Exec timed out after 1000ms. Process tree terminated");
  });

  test("exec tools surface clear connection errors from the mocked client", async () => {
    const { server } = createHarness(registerExecTools, {
      resolveError: new Error("Cannot reach moor: connect ECONNREFUSED"),
    });

    await expect(server.call("moor_exec", { project: "app", command: "pwd" })).rejects.toThrow(
      "Cannot reach moor: connect ECONNREFUSED",
    );
  });
});

describe("env, cron, volume, and file tools", () => {
  test("moor_env_set requires vars", async () => {
    const { server } = createHarness(registerEnvTools);

    await expect(server.call("moor_env_set", { project: "app" })).rejects.toThrow(
      "expected record",
    );
  });

  test("moor_env_set merges with existing envs and restarts running projects", async () => {
    const { api, server } = createHarness(registerEnvTools);
    api.on("GET", "/api/projects/7/envs", () => json([{ key: "A", value: "1" }]));
    api.on("PUT", "/api/projects/7/envs", () => noContent());
    api.on("POST", "/api/projects/7/stop", () => noContent());
    api.on("POST", "/api/projects/7/start", () => noContent());

    const result = await server.call("moor_env_set", {
      project: "app",
      vars: { B: "2" },
    });

    expect(api.calls[1]).toEqual({
      method: "PUT",
      path: "/api/projects/7/envs",
      body: [
        { key: "A", value: "1" },
        { key: "B", value: "2" },
      ],
    });
    expect(toolText(result)).toBe("Set B on app. Container restarted.");
  });

  test("moor_env_set surfaces JSON errors from the env write", async () => {
    const { api, server } = createHarness(registerEnvTools);
    api.on("GET", "/api/projects/7/envs", () => json([]));
    api.on("PUT", "/api/projects/7/envs", () => errorJson("env key is invalid", 400));

    await expect(
      server.call("moor_env_set", { project: "app", vars: { "BAD KEY": "x" } }),
    ).rejects.toThrow("Failed to set envs: env key is invalid");
  });

  test("cron create validates unsupported schedules before resolving the project", async () => {
    const { api, server } = createHarness(registerEnvTools);

    await expect(
      server.call("moor_cron_create", {
        project: "missing",
        name: "nightly",
        schedule: "0 0 * * 7",
        command: "echo hi",
      }),
    ).rejects.toThrow("Invalid schedule: day-of-week: 7 out of bounds [0-6]");
    expect(api.calls).toHaveLength(0);
  });

  test("cron update shapes enabled into the API's numeric flag", async () => {
    const { api, server } = createHarness(registerEnvTools);
    api.on("PUT", "/api/crons/3", () =>
      json({
        id: 3,
        enabled: 1,
        name: "nightly",
        schedule: "0 3 * * *",
        command: "echo hi",
      }),
    );

    const result = await server.call("moor_cron_update", {
      cron_id: 3,
      enabled: true,
    });

    expect(api.calls[0]).toEqual({
      method: "PUT",
      path: "/api/crons/3",
      body: { enabled: 1 },
    });
    expect(toolText(result)).toContain('"enabled": 1');
  });

  test("file set requires exactly one content source via API error text", async () => {
    const { api, server } = createHarness(registerEnvTools);
    api.on("POST", "/api/projects/7/files", () =>
      errorJson("provide exactly one of content or env_ref", 400),
    );

    await expect(
      server.call("moor_file_set", {
        project: "app",
        path: "/etc/app.conf",
        content: "inline",
        env_ref: "APP_CONF",
      }),
    ).rejects.toThrow("Failed: provide exactly one of content or env_ref");
  });
});

describe("server tools", () => {
  test("moor_stats renders server and Docker disk stats", async () => {
    const { api, server } = createHarness(registerServerTools);
    api.on("GET", "/api/server/stats", () =>
      json({
        hostname: "moorbox",
        os: "linux",
        uptime: "1 day",
        cpu: { percent: 25, cores: 4 },
        load: { one_min: 1.25, cores: 4, normalized_percent: 31 },
        memory: { total: "8 GB", used: "3 GB", percent: 38 },
        disk: { total: "100 GB", used: "50 GB", percent: 50 },
        disks: [{ mount: "/", total: "100 GB", used: "50 GB", percent: 50, label: "root" }],
        containers: { running: 2, total: 3 },
        docker: {
          images: { bytes: 1536, reclaimable_bytes: 512, count: 4, unused_count: 1 },
          containers: { bytes: 0, reclaimable_bytes: 0, count: 3, stopped_count: 1 },
          volumes: { bytes: 10 * 1024 * 1024, reclaimable_bytes: 0, count: 2, unused_count: 0 },
          build_cache: { bytes: 3 * 1024 ** 3, reclaimable_bytes: 1024, count: 8 },
        },
      }),
    );

    const result = await server.call("moor_stats");
    const text = toolText(result);

    expect(text).toContain("Host: moorbox");
    expect(text).toContain("Load (1m): 1.25 on 4 cores (31%)");
    expect(text).toContain("root (/): 50 GB / 100 GB (50%)");
    expect(text).toContain("Images: 1.5 KB (512 B reclaimable, 1/4 unused)");
    expect(text).toContain("Volumes: 10 MB (0 B reclaimable, 0/2 unused)");
    expect(text).toContain("Build cache: 3.0 GB (1.0 KB reclaimable, 8 entries)");
  });

  test("moor_drain_status renders drain state and active work", async () => {
    const { api, server } = createHarness(registerServerTools);
    api.on("GET", "/api/server/drain", () =>
      json({
        state: {
          enabled: true,
          reason: "updating moor",
          started_at: "2026-07-06T12:00:00Z",
          expires_at: "2026-07-06T12:30:00Z",
          clear_after_version: null,
        },
        active_work: {
          builds_in_flight: 1,
          execs_in_flight: 2,
          crons_in_flight: 0,
          terminals_open: 3,
        },
      }),
    );

    expect(toolText(await server.call("moor_drain_status"))).toBe(
      [
        "drain: ON (reason: updating moor)",
        "  started_at:  2026-07-06T12:00:00Z",
        "  expires_at:  2026-07-06T12:30:00Z (auto-clear)",
        "active: builds=1 execs=2 crons=0 terminals=3",
      ].join("\n"),
    );
  });

  test("moor_drain_enable surfaces JSON errors", async () => {
    const { api, server } = createHarness(registerServerTools);
    api.on("POST", "/api/server/drain/enable", () => errorJson("ttl_minutes is invalid", 400));

    await expect(
      server.call("moor_drain_enable", { reason: "test", ttl_minutes: -1 }),
    ).rejects.toThrow("drain enable failed: 400 ttl_minutes is invalid");
  });
});

describe("credential tools", () => {
  test("source credential check requires github_url", async () => {
    const { server } = createHarness(registerCredentialTools);

    await expect(server.call("moor_source_credential_check", {})).rejects.toThrow(
      "expected string",
    );
  });

  test("source credential check returns structured API failures as tool errors", async () => {
    const { api, server } = createHarness(registerCredentialTools);
    api.on("POST", "/api/server/source-credentials/check", () =>
      json(
        {
          code: "multiple_credentials",
          reason: "choose a credential",
          candidates: [1, 2],
        },
        { status: 409 },
      ),
    );

    const result = await server.call("moor_source_credential_check", {
      github_url: "https://github.com/owner/private",
    });

    expect(isErrorResult(result)).toBe(true);
    expect(toolText(result)).toBe(
      "check failed: code=multiple_credentials reason=choose a credential",
    );
    expect(structuredContent(result)).toEqual({
      code: "multiple_credentials",
      reason: "choose a credential",
      candidates: [1, 2],
    });
  });

  test("registry credential update validates that at least one field changes", async () => {
    const { api, server } = createHarness(registerCredentialTools);

    await expect(server.call("moor_registry_credential_update", { id: 1 })).rejects.toThrow(
      "must provide at least one of username or secret to update",
    );
    expect(api.calls).toHaveLength(0);
  });
});

describe("cleanup tools", () => {
  test("cleanup plan renders candidates and candidates_json", async () => {
    const { api, server } = createHarness(registerCleanupTools);
    api.on("POST", "/api/server/cleanup/plan", () =>
      json({
        total_reclaimable_bytes: 10 * 1024 * 1024,
        candidates: [
          { category: "build_cache", reclaimable_bytes: 1536, label: "all" },
          {
            category: "dangling_image",
            id: "sha256:abc",
            reclaimable_bytes: 1024,
            repo_tags: [],
            label: "abc",
          },
        ],
      }),
    );

    const result = await server.call("moor_cleanup_plan", { scope: ["build_cache"] });
    const text = toolText(result);

    expect(api.calls[0]).toEqual({
      method: "POST",
      path: "/api/server/cleanup/plan",
      body: { scope: ["build_cache"] },
    });
    expect(text).toContain("2 candidate(s), total reclaimable: 10 MB.");
    expect(text).toContain("build_cache [all] \u2014 1.5 KB reclaimable");
    expect(text).toContain("dangling_image [abc] id=sha256:abc 1.0 KB");
    expect(text).toContain("candidates_json:");
  });

  test("cleanup execute requires at least one candidate", async () => {
    const { server } = createHarness(registerCleanupTools);

    await expect(server.call("moor_cleanup_execute", { candidates: [] })).rejects.toThrow(
      "Too small",
    );
  });

  test("cleanup execute surfaces JSON API errors", async () => {
    const { api, server } = createHarness(registerCleanupTools);
    api.on("POST", "/api/server/cleanup/execute", () => errorJson("docker prune failed", 500));

    await expect(
      server.call("moor_cleanup_execute", { candidates: [{ category: "build_cache" }] }),
    ).rejects.toThrow("execute failed: 500 docker prune failed");
  });
});

describe("update tools", () => {
  test("moor_update_status renders preflight state", async () => {
    const { api, server } = createHarness(registerUpdateTools);
    api.on("GET", "/api/server/update-status", () =>
      json({
        current: {
          version: "0.53.0",
          image_id: "sha256:local",
          repo_digest: null,
          started_at: "2026-07-06T12:00:00Z",
        },
        available: {
          latest_tag: "latest",
          latest_digest: null,
          update_available: null,
          registry_error: "timeout",
        },
        active_work: {
          builds_in_flight: 1,
          execs_in_flight: 0,
          crons_in_flight: 0,
          terminals_open: 0,
        },
        db_backup: {
          last_backup_at: null,
          age_seconds: null,
          location: null,
        },
        safe_to_update: false,
        unsafe_reasons: ["builds in flight"],
        recommended_command: "docker compose pull moor && docker compose up -d moor",
      }),
    );

    expect(toolText(await server.call("moor_update_status"))).toBe(
      [
        "moor 0.53.0 (image_id: sha256:local)",
        "repo_digest: (none \u2014 locally built or stale inspect)",
        "update availability unknown \u2014 registry unreachable: timeout",
        "active: builds=1 execs=0 crons=0 terminals=0",
        "safe_to_update: NO",
        "  - builds in flight",
        "recommended: docker compose pull moor && docker compose up -d moor",
      ].join("\n"),
    );
  });

  test("moor_update_apply surfaces structured refusal details", async () => {
    const { api, server } = createHarness(registerUpdateTools);
    api.on("POST", "/api/server/update/apply", () =>
      json(
        {
          error: {
            code: "unsafe",
            reason: "active work is running",
            unsafe_reasons: ["1 build in flight", "1 exec in flight"],
          },
        },
        { status: 409 },
      ),
    );

    await expect(server.call("moor_update_apply", { bypass: ["unknown_digest"] })).rejects.toThrow(
      "moor_update_apply refused [unsafe]: active work is running\nunsafe_reasons:\n  - 1 build in flight\n  - 1 exec in flight",
    );
  });

  test("moor_update_audit passes limit and renders empty audit list", async () => {
    const { api, server } = createHarness(registerUpdateTools);
    api.on("GET", "/api/server/update/audit?limit=5", () => json({ rows: [] }));

    const result = await server.call("moor_update_audit", { limit: 5, tail_bytes: 0 });

    expect(api.calls[0]).toEqual({
      method: "GET",
      path: "/api/server/update/audit?limit=5",
    });
    expect(toolText(result)).toContain("no update attempts recorded yet");
  });
});
