import { afterEach, describe, expect, test } from "bun:test";
import { deployCommand, parseDeployArgs } from "./deploy";

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

function sseResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
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

describe("project deploy command", () => {
  test("parses the core deploy flags into one API request", () => {
    expect(
      parseDeployArgs([
        "app",
        "--github-url",
        "https://github.com/example/app",
        "--branch",
        "next",
        "--dockerfile",
        "ops/Dockerfile",
        "--domain",
        "app.example.com",
        "--domain-port",
        "8080",
        "--source-credential-id",
        "42",
        "--env-file",
        "env.json",
        "--update-existing",
        "--no-run",
        "--json",
      ]),
    ).toEqual({
      input: {
        name: "app",
        github_url: "https://github.com/example/app",
        branch: "next",
        dockerfile: "ops/Dockerfile",
        domain: "app.example.com",
        domain_port: 8080,
        source_credential_id: 42,
        update_existing: true,
        run: false,
      },
      envFile: "env.json",
      json: true,
    });
  });

  test("renders argument errors as JSON regardless of flag order", async () => {
    const capture = captureOutput();

    const exitCode = await deployCommand(["app", "--unknown", "--json"], capture.output);

    expect(exitCode).toBe(1);
    expect(capture.stdout).toEqual([]);
    expect(capture.stderr).toEqual(['{"error":"Unknown option: --unknown"}\n']);
  });

  test("does not accept environment values on argv", () => {
    expect(parseDeployArgs(["app", "--env", "TOKEN=secret-value"]).error).toBe(
      "Unknown option: --env",
    );
  });

  test("rejects a flag used as a missing option value", () => {
    expect(parseDeployArgs(["app", "--docker-image", "--json", "--update-existing"])).toEqual({
      json: true,
      error: "--docker-image requires a value",
    });
    expect(parseDeployArgs(["app", "--env-file", "-"]).envFile).toBe("-");
  });

  test("requires a positive integer source credential ID", () => {
    expect(parseDeployArgs(["app", "--source-credential-id", "0"]).error).toBe(
      "--source-credential-id must be a positive integer",
    );
    expect(parseDeployArgs(["app", "--source-credential-id", "1.5"]).error).toBe(
      "--source-credential-id must be a positive integer",
    );
  });

  test("reads env values outside argv and renders the human stream", async () => {
    configureClientEnv();
    const calls: Array<{ path: string; body: unknown }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      calls.push({ path: url.pathname, body: JSON.parse(String(init?.body)) });
      return sseResponse([
        'event: deploy\ndata: {"action":"created","project_id":7,"project_name":"app",',
        '"env_keys":["TOKEN"],"run":true,"env_changes_pending_restart":false}\n\n',
        'event: log\ndata: "pull complete\\n"\n\nevent: done\ndata: "Container started"\n\n',
      ]);
    }) as typeof fetch;
    const readPaths: string[] = [];
    const capture = captureOutput(async (path) => {
      readPaths.push(path);
      return '{"TOKEN":"secret-value"}';
    });

    const exitCode = await deployCommand(
      ["app", "--docker-image", "nginx:alpine", "--env-file", "-"],
      capture.output,
    );

    expect(exitCode).toBe(0);
    expect(readPaths).toEqual(["-"]);
    expect(calls).toEqual([
      {
        path: "/api/deploy",
        body: {
          name: "app",
          docker_image: "nginx:alpine",
          env: { TOKEN: "secret-value" },
        },
      },
    ]);
    expect(capture.stdout.join("")).toBe(
      "Created project app (id=7).\nMerged 1 env var(s): TOKEN.\npull complete\nContainer started\n",
    );
    expect(capture.stderr).toEqual([]);
  });

  test("emits each chunked stream event as JSONL", async () => {
    configureClientEnv();
    globalThis.fetch = (async (..._args: Parameters<typeof fetch>): Promise<Response> =>
      sseResponse([
        'event: deploy\ndata: {"action":"updated","project_id":7,',
        '"project_name":"app","env_keys":[],"run":true,',
        '"env_changes_pending_restart":false}\n\nevent: log\nda',
        'ta: "started\\n"\n\nevent: done\ndata: "Container started"\n\n',
      ])) as typeof fetch;
    const capture = captureOutput();

    const exitCode = await deployCommand(
      ["app", "--docker-image", "nginx:alpine", "--update-existing", "--json"],
      capture.output,
    );

    expect(exitCode).toBe(0);
    expect(capture.stdout.map((line) => JSON.parse(line))).toEqual([
      {
        event: "deploy",
        data: {
          action: "updated",
          project_id: 7,
          project_name: "app",
          env_keys: [],
          run: true,
          env_changes_pending_restart: false,
        },
      },
      { event: "log", data: "started\n" },
      { event: "done", data: "Container started" },
    ]);
    expect(capture.stderr).toEqual([]);
  });

  test("returns a nonzero exit for a structured stream failure", async () => {
    configureClientEnv();
    globalThis.fetch = (async (..._args: Parameters<typeof fetch>): Promise<Response> =>
      sseResponse([
        'event: deploy\ndata: {"action":"created","project_id":7,"project_name":"app","env_keys":[],"run":true,"env_changes_pending_restart":false}\n\n',
        'event: structured-error\ndata: {"code":"source_credential_required","message":"credential required"}\n\n',
        'event: error\ndata: "clone failed"\n\n',
      ])) as typeof fetch;
    const capture = captureOutput();

    const exitCode = await deployCommand(
      ["app", "--github-url", "https://github.com/example/app"],
      capture.output,
    );

    expect(exitCode).toBe(1);
    expect(capture.stderr).toEqual(["Error [source_credential_required]: credential required\n"]);
  });

  test("keeps reader failures in the JSONL stream after streaming begins", async () => {
    configureClientEnv();
    globalThis.fetch = (async (..._args: Parameters<typeof fetch>): Promise<Response> =>
      sseResponse([
        'event: deploy\ndata: {"action":"created","project_id":7,"project_name":"app","env_keys":[],"run":true,"env_changes_pending_restart":false}\n\n',
        "event: log\ndata: not-json\n\n",
      ])) as typeof fetch;
    const capture = captureOutput();

    const exitCode = await deployCommand(
      ["app", "--docker-image", "nginx:alpine", "--json"],
      capture.output,
    );

    expect(exitCode).toBe(1);
    expect(capture.stderr).toEqual([]);
    const events = capture.stdout.map((line) => JSON.parse(line));
    expect(events[0]).toEqual({
      event: "deploy",
      data: {
        action: "created",
        project_id: 7,
        project_name: "app",
        env_keys: [],
        run: true,
        env_changes_pending_restart: false,
      },
    });
    expect(events[1]?.event).toBe("error");
    expect(events[1]?.data).toContain("JSON");
  });

  test("renders pre-stream API failures as JSON on stderr", async () => {
    configureClientEnv();
    globalThis.fetch = (async (..._args: Parameters<typeof fetch>): Promise<Response> =>
      Response.json({ error: "project already exists" }, { status: 409 })) as typeof fetch;
    const capture = captureOutput();

    const exitCode = await deployCommand(
      ["app", "--docker-image", "nginx:alpine", "--json"],
      capture.output,
    );

    expect(exitCode).toBe(1);
    expect(capture.stdout).toEqual([]);
    expect(capture.stderr).toEqual(['{"error":"project already exists","status":409}\n']);
  });

  test("preserves structured pre-stream API failures in JSON mode", async () => {
    configureClientEnv();
    globalThis.fetch = (async (..._args: Parameters<typeof fetch>): Promise<Response> =>
      Response.json(
        {
          ok: false,
          code: "credential_not_active",
          source_credential_id: 42,
          state: "failed",
          error: "credential is not active",
        },
        { status: 400 },
      )) as typeof fetch;
    const capture = captureOutput();

    const exitCode = await deployCommand(
      ["app", "--github-url", "https://github.com/example/app", "--json"],
      capture.output,
    );

    expect(exitCode).toBe(1);
    expect(JSON.parse(capture.stderr.join(""))).toEqual({
      ok: false,
      code: "credential_not_active",
      source_credential_id: 42,
      state: "failed",
      error: "credential is not active",
      status: 400,
    });
  });

  test("rejects invalid env JSON before making a request", async () => {
    configureClientEnv();
    let fetchCalled = false;
    globalThis.fetch = (async (..._args: Parameters<typeof fetch>): Promise<Response> => {
      fetchCalled = true;
      return Response.json({});
    }) as typeof fetch;
    const capture = captureOutput(async () => '{"PORT":3000}');

    const exitCode = await deployCommand(
      ["app", "--docker-image", "nginx:alpine", "--env-file", "env.json"],
      capture.output,
    );

    expect(exitCode).toBe(1);
    expect(fetchCalled).toBe(false);
    expect(capture.stderr.join("")).toContain("expected every environment value to be a string");
  });
});
