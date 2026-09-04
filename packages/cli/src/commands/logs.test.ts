import { afterEach, describe, expect, test } from "bun:test";
import { logsCommand, parseLogsArgs } from "./logs";

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

function captureOutput() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    output: {
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
    },
  };
}

function configureClient(
  response: (url: URL) => Response,
): Array<{ path: string; authorization: string | null }> {
  process.env.MOOR_URL = "https://moor.test";
  process.env.MOOR_API_KEY = "test-key";
  const requests: Array<{ path: string; authorization: string | null }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    requests.push({
      path: `${url.pathname}${url.search}`,
      authorization: new Headers(init?.headers).get("Authorization"),
    });
    return response(url);
  }) as typeof fetch;
  return requests;
}

describe("logs command", () => {
  test("parses finite JSON arguments and rejects unsupported JSON follow mode", () => {
    expect(parseLogsArgs(["api", "-n", "25", "--json"])).toEqual({
      project: "api",
      follow: false,
      tail: 25,
      json: true,
    });
    expect(parseLogsArgs(["api", "--follow", "--json"]).error).toBe(
      "--json cannot be used with --follow",
    );
    expect(parseLogsArgs(["api", "--lines", "0", "--json"]).error).toBe(
      "--lines must be a positive integer",
    );
    expect(parseLogsArgs(["api", "-n", "-1", "--json"]).error).toBe(
      "-n must be a positive integer",
    );
    expect(parseLogsArgs(["api", "-n", "--json"]).error).toBe("-n requires a value");
  });

  test("emits one JSON response and uses shared exact-name selector semantics", async () => {
    const requests = configureClient((url) => {
      if (url.pathname === "/api/projects") {
        return Response.json([
          { id: 7, name: "api" },
          { id: 8, name: "7" },
        ]);
      }
      return Response.json({ logs: "ready\n", lastTimestamp: 42, state: "ok" });
    });
    const capture = captureOutput();

    const exitCode = await logsCommand(["7", "-n", "25", "--json"], capture.output);

    expect(exitCode).toBe(0);
    expect(capture.stdout).toEqual(['{"logs":"ready\\n","lastTimestamp":42,"state":"ok"}\n']);
    expect(capture.stderr).toEqual([]);
    expect(requests).toEqual([
      { path: "/api/projects", authorization: "Bearer test-key" },
      { path: "/api/projects/8/logs?tail=25", authorization: "Bearer test-key" },
    ]);
  });

  test("preserves raw human log output", async () => {
    configureClient((url) =>
      url.pathname === "/api/projects"
        ? Response.json([{ id: 7, name: "api" }])
        : Response.json({ logs: "ready\n", lastTimestamp: 42, state: "ok" }),
    );
    const capture = captureOutput();

    const exitCode = await logsCommand(["api"], capture.output);

    expect(exitCode).toBe(0);
    expect(capture.stdout).toEqual(["ready\n"]);
    expect(capture.stderr).toEqual([]);
  });

  test("preserves structured API failures on JSON stderr", async () => {
    configureClient((url) =>
      url.pathname === "/api/projects"
        ? Response.json([{ id: 7, name: "api" }])
        : Response.json(
            { logs: "", lastTimestamp: 0, state: "docker_error", error: "daemon unavailable" },
            { status: 502 },
          ),
    );
    const capture = captureOutput();

    const exitCode = await logsCommand(["api", "--json"], capture.output);

    expect(exitCode).toBe(1);
    expect(capture.stdout).toEqual([]);
    expect(JSON.parse(capture.stderr.join(""))).toEqual({
      logs: "",
      lastTimestamp: 0,
      state: "docker_error",
      error: "daemon unavailable",
      status: 502,
    });
  });

  test("returns a structured nonzero error when the project is not found", async () => {
    configureClient(() => Response.json([{ id: 7, name: "api" }]));
    const capture = captureOutput();

    const exitCode = await logsCommand(["missing", "--json"], capture.output);

    expect(exitCode).toBe(1);
    expect(capture.stdout).toEqual([]);
    expect(capture.stderr).toEqual(['{"error":"Project \\"missing\\" not found"}\n']);
  });

  test("rejects JSON follow mode before making a request", async () => {
    const requests = configureClient(() => Response.json([]));
    const capture = captureOutput();

    const exitCode = await logsCommand(["api", "--json", "--follow"], capture.output);

    expect(exitCode).toBe(1);
    expect(requests).toEqual([]);
    expect(capture.stdout).toEqual([]);
    expect(capture.stderr).toEqual(['{"error":"--json cannot be used with --follow"}\n']);
  });

  test("keeps missing client configuration machine-readable", async () => {
    delete process.env.MOOR_URL;
    process.env.MOOR_API_KEY = "test-key";
    const capture = captureOutput();

    const exitCode = await logsCommand(["api", "--json"], capture.output);

    expect(exitCode).toBe(1);
    expect(capture.stdout).toEqual([]);
    expect(capture.stderr).toEqual(['{"error":"MOOR_URL is not set"}\n']);
  });
});
