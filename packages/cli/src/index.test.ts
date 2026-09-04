import { expect, test } from "bun:test";
import { join } from "node:path";

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
      return Response.json(project);
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
      path: "/api/projects/7",
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
