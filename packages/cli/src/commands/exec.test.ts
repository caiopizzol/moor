import { expect, test } from "bun:test";
import { join } from "node:path";

async function fixture(
  check: (
    run: (args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
    requests: Array<{ path: string; method: string; auth: string | null; body: unknown }>,
  ) => Promise<void>,
  result: unknown = { exitCode: 0, stdout: "hello\n", stderr: "warning\n" },
  status = 200,
  projects: unknown = [
    { id: 7, name: "worker" },
    { id: 8, name: "7" },
  ],
) {
  const requests: Array<{ path: string; method: string; auth: string | null; body: unknown }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push({
        path,
        method: request.method,
        auth: request.headers.get("Authorization"),
        body: request.method === "POST" ? await request.json() : null,
      });
      if (path === "/api/projects") return Response.json(projects);
      if (path !== "/api/projects/8/exec")
        return Response.json({ error: "Wrong project" }, { status: 404 });
      return Response.json(result, { status });
    },
  });
  try {
    await check(async (args) => {
      const child = Bun.spawn({
        cmd: [process.execPath, join(import.meta.dir, "../index.ts"), "exec", ...args],
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
    }, requests);
  } finally {
    await server.stop(true);
  }
}

test("exec JSON preserves output, auth, name precedence, and command-side options", async () => {
  await fixture(async (run, requests) => {
    expect(await run(["7", "--json", "--", "printf '%s' \"$HOME\"", "--help", "--json"])).toEqual({
      exitCode: 0,
      stdout: '{"exitCode":0,"stdout":"hello\\n","stderr":"warning\\n"}\n',
      stderr: "",
    });
    expect(requests).toEqual([
      { path: "/api/projects", method: "GET", auth: "Bearer test-key", body: null },
      {
        path: "/api/projects/8/exec",
        method: "POST",
        auth: "Bearer test-key",
        body: { command: "printf '%s' \"$HOME\" --help --json" },
      },
    ]);
  });
});

test("exec propagates remote nonzero exit while retaining its JSON result", async () => {
  await fixture(
    async (run) => {
      expect(await run(["--json", "7", "--", "false"])).toEqual({
        exitCode: 23,
        stdout: '{"exitCode":23,"stdout":"","stderr":"failed"}\n',
        stderr: "",
      });
    },
    { exitCode: 23, stdout: "", stderr: "failed" },
  );
});

test("exec preserves legacy human streams and command separators", async () => {
  await fixture(async (run, requests) => {
    for (const args of [
      ["7", "echo", "--", "--json"],
      ["7", "--", "echo", "--", "--json"],
    ]) {
      expect(await run(args)).toEqual({ exitCode: 0, stdout: "hello\n", stderr: "warning\n" });
      expect(requests.at(-1)?.body).toEqual({ command: "echo -- --json" });
    }
  });
});

test("exec preserves a legacy shell command beginning with a dash", async () => {
  await fixture(async (run, requests) => {
    expect(await run(["7", "-l", "--", "echo"])).toEqual({
      exitCode: 0,
      stdout: "hello\n",
      stderr: "warning\n",
    });
    expect(requests.at(-1)?.body).toEqual({ command: "-l -- echo" });
  });
});

for (const projects of [{}, null, [null], [{ id: "8", name: "7" }]]) {
  test(`exec rejects invalid project response ${JSON.stringify(projects)} without POST`, async () => {
    await fixture(
      async (run, requests) => {
        expect(await run(["7", "--json", "--", "echo"])).toEqual({
          exitCode: 1,
          stdout: "",
          stderr: '{"error":"Invalid project response"}\n',
        });
        expect(requests.map((r) => r.method)).toEqual(["GET"]);
      },
      undefined,
      200,
      projects,
    );
  });
}

for (const [args, error] of [
  [["7", "--json", "echo"], "--json requires -- before the command"],
  [["7", "ls", "--json"], "--json requires -- before the command"],
  [["--json", "--", "echo"], "Project is required"],
  [["7", "--json", "--"], "Command is required"],
  [["7", "--json", "extra", "--", "echo"], "Unexpected argument: extra"],
  [["7", "--json", "--bad", "--", "echo"], "Unknown option: --bad"],
] as const) {
  test(`exec rejects ${args.join(" ")} before requests`, async () => {
    await fixture(async (run, requests) => {
      expect(await run([...args])).toEqual({
        exitCode: 1,
        stdout: "",
        stderr: `${JSON.stringify({ error })}\n`,
      });
      expect(requests).toEqual([]);
    });
  });
}

test("exec help does not execute a command", async () => {
  await fixture(async (run, requests) => {
    const result = await run(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--json requires --");
    expect(requests).toEqual([]);
  });
});

test("exec missing project fails without POST", async () => {
  await fixture(async (run, requests) => {
    expect(await run(["missing", "--json", "--", "echo"])).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: `${JSON.stringify({ error: 'Project "missing" not found' })}\n`,
    });
    expect(requests.map((r) => r.method)).toEqual(["GET"]);
  });
});

test("exec HTTP errors use shared JSON stderr", async () => {
  await fixture(
    async (run) => {
      expect(await run(["7", "--json", "--", "echo"])).toEqual({
        exitCode: 1,
        stdout: "",
        stderr: '{"error":"Draining","code":"drain","status":503}\n',
      });
    },
    { error: "Draining", code: "drain" },
    503,
  );
});

test("exec rejects invalid API results instead of reporting success", async () => {
  await fixture(
    async (run) => {
      expect(await run(["7", "--json", "--", "echo"])).toEqual({
        exitCode: 1,
        stdout: "",
        stderr: '{"error":"Invalid exec response"}\n',
      });
    },
    { stdout: "hello", stderr: "" },
  );
});
