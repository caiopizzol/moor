import { afterEach, describe, expect, test } from "bun:test";
import { envCommand, parseEnvSetArgs } from "./env";

const originalFetch = globalThis.fetch;
const originalMoorUrl = process.env.MOOR_URL;
const originalMoorApiKey = process.env.MOOR_API_KEY;

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv("MOOR_URL", originalMoorUrl);
  restoreEnv("MOOR_API_KEY", originalMoorApiKey);
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function configureClientEnv(): void {
  process.env.MOOR_URL = "https://moor.test";
  process.env.MOOR_API_KEY = "test-key";
}

function captureOutput(readText: (path: string) => Promise<string> = async () => "") {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    output: {
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
      readText,
    },
  };
}

describe("env set command", () => {
  test("keeps human KEY=VALUE input separate from JSON file input", () => {
    expect(parseEnvSetArgs(["app", "A=1", "TOKEN=a=b"])).toEqual({
      project: "app",
      vars: { A: "1", TOKEN: "a=b" },
      envFile: undefined,
      json: false,
    });
    expect(parseEnvSetArgs(["app", "--env-file", "-", "--json"])).toEqual({
      project: "app",
      vars: {},
      envFile: "-",
      json: true,
    });
    expect(parseEnvSetArgs(["app", "TOKEN=secret", "--json"]).error).toBe(
      "--json requires --env-file so values stay out of argv",
    );
    expect(parseEnvSetArgs(["app", "A=1", "--env-file", "-"]).error).toBe(
      "Use either --env-file or KEY=VALUE arguments, not both",
    );
  });

  test("preserves human KEY=VALUE syntax while using one mutation request", async () => {
    configureClientEnv();
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push(
        body === undefined ? { method, path: url.pathname } : { method, path: url.pathname, body },
      );

      if (method === "GET" && url.pathname === "/api/projects") {
        return Response.json([{ id: 7, name: "app", status: "running" }]);
      }
      if (method === "POST" && url.pathname === "/api/projects/7/envs") {
        return Response.json({ updated_keys: ["B"], restarted: true });
      }
      throw new Error(`Unexpected request: ${method} ${url.pathname}`);
    }) as typeof fetch;
    const capture = captureOutput();

    const exitCode = await envCommand(["set", "app", "B=2"], capture.output);

    expect(exitCode).toBe(0);
    expect(calls).toEqual([
      { method: "GET", path: "/api/projects" },
      { method: "POST", path: "/api/projects/7/envs", body: { vars: { B: "2" } } },
    ]);
    expect(capture.stdout).toEqual(["Set B\n", "app restarted.\n"]);
    expect(capture.stderr).toEqual([]);
  });

  test("reads JSON values outside argv and emits one JSON document", async () => {
    configureClientEnv();
    const calls: Array<{ path: string; body?: unknown }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push(body === undefined ? { path: url.pathname } : { path: url.pathname, body });
      if (url.pathname === "/api/projects") {
        return Response.json([{ id: 7, name: "app", status: "stopped" }]);
      }
      return Response.json({ updated_keys: ["TOKEN"], restarted: false });
    }) as typeof fetch;
    const readPaths: string[] = [];
    const capture = captureOutput(async (path) => {
      readPaths.push(path);
      return '{"TOKEN":"secret-value"}';
    });

    const exitCode = await envCommand(["set", "app", "--env-file", "-", "--json"], capture.output);

    expect(exitCode).toBe(0);
    expect(readPaths).toEqual(["-"]);
    expect(calls).toEqual([
      { path: "/api/projects" },
      { path: "/api/projects/7/envs", body: { vars: { TOKEN: "secret-value" } } },
    ]);
    expect(capture.stdout).toEqual(['{"updated_keys":["TOKEN"],"restarted":false}\n']);
    expect(capture.stderr).toEqual([]);
  });

  test("preserves partial-success fields in JSON errors", async () => {
    configureClientEnv();
    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.pathname === "/api/projects") {
        return Response.json([{ id: 7, name: "app", status: "running" }]);
      }
      return Response.json(
        {
          error: "Environment variables were updated, but restart failed: daemon unavailable",
          env_updated: true,
          updated_keys: ["TOKEN"],
        },
        { status: 500 },
      );
    }) as typeof fetch;
    const capture = captureOutput(async () => '{"TOKEN":"secret-value"}');

    const exitCode = await envCommand(["set", "app", "--env-file", "-", "--json"], capture.output);

    expect(exitCode).toBe(1);
    expect(capture.stdout).toEqual([]);
    expect(JSON.parse(capture.stderr.join(""))).toEqual({
      error: "Environment variables were updated, but restart failed: daemon unavailable",
      env_updated: true,
      updated_keys: ["TOKEN"],
      status: 500,
    });
  });

  test("rejects invalid env JSON before resolving the project", async () => {
    configureClientEnv();
    let fetchCalled = false;
    globalThis.fetch = (async (..._args: Parameters<typeof fetch>): Promise<Response> => {
      fetchCalled = true;
      return Response.json({});
    }) as typeof fetch;
    const capture = captureOutput(async () => '{"PORT":3000}');

    const exitCode = await envCommand(
      ["set", "app", "--env-file", "env.json", "--json"],
      capture.output,
    );

    expect(exitCode).toBe(1);
    expect(fetchCalled).toBe(false);
    expect(capture.stderr).toEqual([
      '{"error":"Failed to read --env-file: expected every environment value to be a string"}\n',
    ]);
  });
});
