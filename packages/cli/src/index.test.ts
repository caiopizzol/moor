import { expect, test } from "bun:test";
import { join } from "node:path";

test("restart preserves JSON output, authentication, selectors, and failure exit codes", async () => {
  const requests: Array<{ method: string; path: string; authorization: string | null }> = [];
  let failRestart = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push({
        method: request.method,
        path,
        authorization: request.headers.get("Authorization"),
      });
      if (path === "/api/projects")
        return Response.json([
          { id: 7, name: "worker" },
          { id: 8, name: "7" },
        ]);
      if (request.method === "POST" && path === "/api/projects/8/restart") {
        return failRestart
          ? Response.json({ error: "Draining", code: "drain" }, { status: 503 })
          : Response.json({ message: "Container restarted" });
      }
      return Response.json({ error: "Unexpected request" }, { status: 404 });
    },
  });
  const run = async (args: string[]) => {
    const child = Bun.spawn({
      cmd: [process.execPath, join(import.meta.dir, "index.ts"), "restart", ...args],
      env: { ...process.env, MOOR_URL: server.url.origin, MOOR_API_KEY: "test-key" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  };
  try {
    expect(await run(["7", "--json"])).toEqual({
      exitCode: 0,
      stdout: '{"message":"Container restarted"}\n',
      stderr: "",
    });
    failRestart = true;
    expect(await run(["--json", "7"])).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: '{"error":"Draining","code":"drain","status":503}\n',
    });
    expect(requests).toEqual([
      { method: "GET", path: "/api/projects", authorization: "Bearer test-key" },
      { method: "POST", path: "/api/projects/8/restart", authorization: "Bearer test-key" },
      { method: "GET", path: "/api/projects", authorization: "Bearer test-key" },
      { method: "POST", path: "/api/projects/8/restart", authorization: "Bearer test-key" },
    ]);
    requests.length = 0;
    expect(await run(["missing", "--json"])).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: '{"error":"Project \\"missing\\" not found"}\n',
    });
    expect(requests.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: "GET", path: "/api/projects" },
    ]);
    requests.length = 0;
    for (const [args, error] of [
      [["--json"], "Project is required"],
      [["7", "extra", "--json"], "Unexpected argument: extra"],
      [["7", "--unknown", "--json"], "Unknown option: --unknown"],
    ] as const) {
      expect(await run([...args])).toEqual({
        exitCode: 1,
        stdout: "",
        stderr: `${JSON.stringify({ error })}\n`,
      });
    }
    expect(await run(["--help"])).toEqual({
      exitCode: 0,
      stdout: "Usage: moor restart <project> [--json]\n",
      stderr: "",
    });
    expect(requests).toEqual([]);
  } finally {
    await server.stop(true);
  }
});

test("project deploy propagates a JSON API failure to the process exit code", async () => {
  let request:
    | {
        method: string;
        path: string;
        authorization: string | null;
      }
    | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (incoming) => {
      request = {
        method: incoming.method,
        path: new URL(incoming.url).pathname,
        authorization: incoming.headers.get("Authorization"),
      };
      return Response.json({ error: "project already exists" }, { status: 409 });
    },
  });

  try {
    const child = Bun.spawn({
      cmd: [
        globalThis.process.execPath,
        join(import.meta.dir, "index.ts"),
        "project",
        "deploy",
        "app",
        "--docker-image",
        "nginx:alpine",
        "--json",
      ],
      env: {
        ...globalThis.process.env,
        MOOR_URL: server.url.origin,
        MOOR_API_KEY: "test-key",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (typeof child.stdout === "number" || typeof child.stderr === "number") {
      throw new Error("expected piped process output");
    }

    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe('{"error":"project already exists","status":409}\n');
    expect(request).toEqual({
      method: "POST",
      path: "/api/deploy",
      authorization: "Bearer test-key",
    });
  } finally {
    await server.stop(true);
  }
});

test("project list sends bearer auth and emits one JSON document", async () => {
  let request:
    | {
        method: string;
        path: string;
        authorization: string | null;
      }
    | undefined;
  const projects = [{ id: 7, name: "api", status: "running", live_status: "running" }];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (incoming) => {
      request = {
        method: incoming.method,
        path: new URL(incoming.url).pathname,
        authorization: incoming.headers.get("Authorization"),
      };
      return Response.json(projects);
    },
  });

  try {
    const child = Bun.spawn({
      cmd: [
        globalThis.process.execPath,
        join(import.meta.dir, "index.ts"),
        "project",
        "list",
        "--json",
      ],
      env: {
        ...globalThis.process.env,
        MOOR_URL: server.url.origin,
        MOOR_API_KEY: "test-key",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (typeof child.stdout === "number" || typeof child.stderr === "number") {
      throw new Error("expected piped process output");
    }

    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual(projects);
    expect(stderr).toBe("");
    expect(request).toEqual({
      method: "GET",
      path: "/api/projects",
      authorization: "Bearer test-key",
    });
  } finally {
    await server.stop(true);
  }
});

test("status forwards project-list arguments while preserving its human alias", async () => {
  const requests: Array<{
    method: string;
    path: string;
    authorization: string | null;
  }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (incoming) => {
      requests.push({
        method: incoming.method,
        path: new URL(incoming.url).pathname,
        authorization: incoming.headers.get("Authorization"),
      });
      if (requests.length > 2) {
        return Response.json({ error: "Unavailable" }, { status: 503 });
      }
      return Response.json([
        {
          id: 7,
          name: "api",
          status: "running",
          live_status: "running",
          github_url: null,
          docker_image: "nginx:alpine",
          domain: null,
        },
      ]);
    },
  });

  async function runStatus(args: string[] = []) {
    const child = Bun.spawn({
      cmd: [globalThis.process.execPath, join(import.meta.dir, "index.ts"), "status", ...args],
      env: {
        ...globalThis.process.env,
        MOOR_URL: server.url.origin,
        MOOR_API_KEY: "test-key",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (typeof child.stdout === "number" || typeof child.stderr === "number") {
      throw new Error("expected piped process output");
    }

    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  }

  try {
    const success = await runStatus();
    expect(success.exitCode).toBe(0);
    expect(success.stdout).toBe(
      "NAME  STATUS   SOURCE        DOMAIN\n" +
        "-----------------------------------\n" +
        "api   running  nginx:alpine  -     \n",
    );
    expect(success.stderr).toBe("");

    const json = await runStatus(["--json"]);
    expect(json.exitCode).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual([
      {
        id: 7,
        name: "api",
        status: "running",
        live_status: "running",
        github_url: null,
        docker_image: "nginx:alpine",
        domain: null,
      },
    ]);
    expect(json.stderr).toBe("");

    const failure = await runStatus();
    expect(failure).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "Error: Failed to list projects: Unavailable\n",
    });
    expect(requests).toEqual([
      { method: "GET", path: "/api/projects", authorization: "Bearer test-key" },
      { method: "GET", path: "/api/projects", authorization: "Bearer test-key" },
      { method: "GET", path: "/api/projects", authorization: "Bearer test-key" },
    ]);
  } finally {
    await server.stop(true);
  }
});

test("logs emits finite JSON and structured failures through the real CLI", async () => {
  const requests: Array<{
    path: string;
    authorization: string | null;
  }> = [];
  let logRequests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (incoming) => {
      const url = new URL(incoming.url);
      requests.push({
        path: `${url.pathname}${url.search}`,
        authorization: incoming.headers.get("Authorization"),
      });
      if (url.pathname === "/api/projects") {
        return Response.json([
          { id: 7, name: "api" },
          { id: 8, name: "7" },
        ]);
      }
      logRequests += 1;
      if (logRequests === 1) {
        return Response.json({ logs: "ready\n", lastTimestamp: 42, state: "ok" });
      }
      return Response.json(
        { logs: "", lastTimestamp: 0, state: "docker_error", error: "daemon unavailable" },
        { status: 502 },
      );
    },
  });

  async function runLogs() {
    const child = Bun.spawn({
      cmd: [
        globalThis.process.execPath,
        join(import.meta.dir, "index.ts"),
        "logs",
        "7",
        "-n",
        "25",
        "--json",
      ],
      env: {
        ...globalThis.process.env,
        MOOR_URL: server.url.origin,
        MOOR_API_KEY: "test-key",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (typeof child.stdout === "number" || typeof child.stderr === "number") {
      throw new Error("expected piped process output");
    }

    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  }

  try {
    const success = await runLogs();
    expect(success.exitCode).toBe(0);
    expect(JSON.parse(success.stdout)).toEqual({
      logs: "ready\n",
      lastTimestamp: 42,
      state: "ok",
    });
    expect(success.stderr).toBe("");

    const failure = await runLogs();
    expect(failure.exitCode).toBe(1);
    expect(failure.stdout).toBe("");
    expect(JSON.parse(failure.stderr)).toEqual({
      logs: "",
      lastTimestamp: 0,
      state: "docker_error",
      error: "daemon unavailable",
      status: 502,
    });
    expect(requests).toEqual([
      { path: "/api/projects", authorization: "Bearer test-key" },
      { path: "/api/projects/8/logs?tail=25", authorization: "Bearer test-key" },
      { path: "/api/projects", authorization: "Bearer test-key" },
      { path: "/api/projects/8/logs?tail=25", authorization: "Bearer test-key" },
    ]);
  } finally {
    await server.stop(true);
  }
});

test("project get sends bearer auth and emits the API record as JSON", async () => {
  let request:
    | {
        method: string;
        path: string;
        authorization: string | null;
      }
    | undefined;
  const project = { id: 7, name: "api", status: "running", live_status: "running" };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (incoming) => {
      request = {
        method: incoming.method,
        path: new URL(incoming.url).pathname,
        authorization: incoming.headers.get("Authorization"),
      };
      return Response.json([project]);
    },
  });

  try {
    const child = Bun.spawn({
      cmd: [
        globalThis.process.execPath,
        join(import.meta.dir, "index.ts"),
        "project",
        "get",
        "7",
        "--json",
      ],
      env: {
        ...globalThis.process.env,
        MOOR_URL: server.url.origin,
        MOOR_API_KEY: "test-key",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (typeof child.stdout === "number" || typeof child.stderr === "number") {
      throw new Error("expected piped process output");
    }

    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual(project);
    expect(stderr).toBe("");
    expect(request).toEqual({
      method: "GET",
      path: "/api/projects",
      authorization: "Bearer test-key",
    });
  } finally {
    await server.stop(true);
  }
});

test("project get propagates a structured API failure to the process exit code", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ error: "Not found" }, { status: 404 }),
  });

  try {
    const child = Bun.spawn({
      cmd: [
        globalThis.process.execPath,
        join(import.meta.dir, "index.ts"),
        "project",
        "get",
        "404",
        "--json",
      ],
      env: {
        ...globalThis.process.env,
        MOOR_URL: server.url.origin,
        MOOR_API_KEY: "test-key",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (typeof child.stdout === "number" || typeof child.stderr === "number") {
      throw new Error("expected piped process output");
    }

    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe('{"error":"Not found","status":404}\n');
  } finally {
    await server.stop(true);
  }
});

test("project list keeps configuration failures valid JSON", async () => {
  for (const scenario of [
    {
      env: { ...globalThis.process.env, MOOR_API_KEY: "test-key", MOOR_URL: undefined },
      error: "MOOR_URL is not set",
    },
    {
      env: { ...globalThis.process.env, MOOR_API_KEY: undefined, MOOR_URL: "https://moor.test" },
      error: "MOOR_API_KEY is not set",
    },
  ]) {
    const child = Bun.spawn({
      cmd: [
        globalThis.process.execPath,
        join(import.meta.dir, "index.ts"),
        "project",
        "list",
        "--json",
      ],
      env: scenario.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (typeof child.stdout === "number" || typeof child.stderr === "number") {
      throw new Error("expected piped process output");
    }

    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(JSON.parse(stderr)).toEqual({ error: scenario.error });
  }
});

test("env list sends bearer auth and emits one JSON document", async () => {
  const requests: Array<{ path: string; authorization: string | null }> = [];
  const variables = [{ id: 1, project_id: 7, key: "PORT", value: "3000" }];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (incoming) => {
      const path = new URL(incoming.url).pathname;
      requests.push({ path, authorization: incoming.headers.get("Authorization") });
      return path === "/api/projects"
        ? Response.json([{ id: 7, name: "api", status: "running" }])
        : Response.json(variables);
    },
  });

  try {
    const child = Bun.spawn({
      cmd: [
        globalThis.process.execPath,
        join(import.meta.dir, "index.ts"),
        "env",
        "list",
        "api",
        "--json",
      ],
      env: {
        ...globalThis.process.env,
        MOOR_URL: server.url.origin,
        MOOR_API_KEY: "test-key",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (typeof child.stdout === "number" || typeof child.stderr === "number") {
      throw new Error("expected piped process output");
    }

    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual(variables);
    expect(stderr).toBe("");
    expect(requests).toEqual([
      { path: "/api/projects", authorization: "Bearer test-key" },
      { path: "/api/projects/7/envs", authorization: "Bearer test-key" },
    ]);
  } finally {
    await server.stop(true);
  }
});

test("env set reads secrets from stdin and uses the atomic API endpoint", async () => {
  const secret = "secret-value-not-in-argv";
  const requests: Array<{
    method: string;
    path: string;
    authorization: string | null;
    body?: unknown;
  }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (incoming) => {
      const request = {
        method: incoming.method,
        path: new URL(incoming.url).pathname,
        authorization: incoming.headers.get("Authorization"),
      };
      if (request.path === "/api/projects") {
        requests.push(request);
        return Response.json([{ id: 7, name: "api", status: "running" }]);
      }
      requests.push({ ...request, body: await incoming.json() });
      return Response.json({ updated_keys: ["TOKEN"], restarted: true });
    },
  });

  try {
    const command = [
      globalThis.process.execPath,
      join(import.meta.dir, "index.ts"),
      "env",
      "set",
      "api",
      "--env-file",
      "-",
      "--json",
    ];
    expect(command.join(" ")).not.toContain(secret);
    const child = Bun.spawn({
      cmd: command,
      env: {
        ...globalThis.process.env,
        MOOR_URL: server.url.origin,
        MOOR_API_KEY: "test-key",
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    if (
      typeof child.stdin === "number" ||
      typeof child.stdout === "number" ||
      typeof child.stderr === "number"
    ) {
      throw new Error("expected piped process input and output");
    }
    child.stdin.write(JSON.stringify({ TOKEN: secret }));
    child.stdin.end();

    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ updated_keys: ["TOKEN"], restarted: true });
    expect(stderr).toBe("");
    expect(requests).toEqual([
      {
        method: "GET",
        path: "/api/projects",
        authorization: "Bearer test-key",
      },
      {
        method: "POST",
        path: "/api/projects/7/envs",
        authorization: "Bearer test-key",
        body: { vars: { TOKEN: secret } },
      },
    ]);
  } finally {
    await server.stop(true);
  }
});

test("env set propagates structured restart failures to the process exit code", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (incoming) => {
      if (new URL(incoming.url).pathname === "/api/projects") {
        return Response.json([{ id: 7, name: "api", status: "running" }]);
      }
      return Response.json(
        {
          error: "Environment variables were updated, but restart failed",
          env_updated: true,
          updated_keys: ["TOKEN"],
        },
        { status: 500 },
      );
    },
  });

  try {
    const child = Bun.spawn({
      cmd: [
        globalThis.process.execPath,
        join(import.meta.dir, "index.ts"),
        "env",
        "set",
        "api",
        "--env-file",
        "-",
        "--json",
      ],
      env: {
        ...globalThis.process.env,
        MOOR_URL: server.url.origin,
        MOOR_API_KEY: "test-key",
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    if (
      typeof child.stdin === "number" ||
      typeof child.stdout === "number" ||
      typeof child.stderr === "number"
    ) {
      throw new Error("expected piped process input and output");
    }
    child.stdin.write('{"TOKEN":"secret-value"}');
    child.stdin.end();

    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(JSON.parse(stderr)).toEqual({
      error: "Environment variables were updated, but restart failed",
      env_updated: true,
      updated_keys: ["TOKEN"],
      status: 500,
    });
  } finally {
    await server.stop(true);
  }
});
