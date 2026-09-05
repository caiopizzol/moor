import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let server: ReturnType<typeof Bun.serve>;
let directory: string;
let respond: () => Response;
let projects: unknown;
const requests: Array<{ path: string; method: string; auth: string | null; body: unknown }> = [];
const lookup = { path: "/api/projects", method: "GET", auth: "Bearer test-key", body: null };
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "moor-job-cli-"));
  requests.length = 0;
  projects = [
    { id: 7, name: "decoy" },
    { id: 8, name: "7" },
  ];
  respond = () => Response.json({ run_id: 12 }, { status: 201 });
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      requests.push({
        path,
        method: req.method,
        auth: req.headers.get("Authorization"),
        body: req.method === "GET" ? null : await req.json(),
      });
      return path === "/api/projects" ? Response.json(projects) : respond();
    },
  });
});
afterEach(async () => {
  await server.stop(true);
  await rm(directory, { recursive: true, force: true });
});
async function run(args: string[], input = "", env: Record<string, string> = {}) {
  const child = Bun.spawn({
    cmd: [process.execPath, join(import.meta.dir, "../index.ts"), "job", ...args],
    env: { ...process.env, MOOR_URL: server.url.origin, MOOR_API_KEY: "test-key", ...env },
    stdin: new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}
test("job start preserves shell text and timeout from stdin/disk using exact project name", async () => {
  const body = { command: 'printf "%s" "$VALUE"; echo $(uname)', timeout_ms: 120000 };
  for (const file of ["-", join(directory, "job.json")]) {
    requests.length = 0;
    if (file !== "-") await writeFile(file, JSON.stringify(body));
    expect(await run(["start", "7", "--file", file, "--json"], JSON.stringify(body))).toEqual({
      exitCode: 0,
      stdout: '{"run_id":12}\n',
      stderr: "",
    });
    expect(requests).toEqual([
      lookup,
      { path: "/api/projects/8/exec/async", method: "POST", auth: "Bearer test-key", body },
    ]);
  }
});
test("job status uses async ID space and retains live tails and failed terminal results", async () => {
  for (const state of ["running", "exited", "error"]) {
    requests.length = 0;
    const body = {
      id: 12,
      state,
      stdout: "live héllo",
      stderr: "tail",
      stdout_total_bytes: 10000,
      stderr_total_bytes: 4,
      exit_code: state === "exited" ? 3 : null,
    };
    respond = () => Response.json(body);
    expect(await run(["status", "12", "--json"])).toEqual({
      exitCode: 0,
      stdout: `${JSON.stringify(body)}\n`,
      stderr: "",
    });
    expect(requests).toEqual([
      { path: "/api/exec/12", method: "GET", auth: "Bearer test-key", body: null },
    ]);
  }
});
test("job stop preserves outcome, fails on survivors, and never retries", async () => {
  for (const ok of [true, false]) {
    requests.length = 0;
    const body = {
      ok,
      state: ok ? "stopped" : "error",
      live_remaining: ok ? 0 : 2,
      message: "outcome",
    };
    respond = () => Response.json(body);
    expect(await run(["stop", "12", "--json"])).toEqual({
      exitCode: ok ? 0 : 1,
      stdout: `${JSON.stringify(body)}\n`,
      stderr: "",
    });
    expect(requests).toEqual([
      { path: "/api/exec/12/stop", method: "POST", auth: "Bearer test-key", body: {} },
    ]);
  }
});
test("job human output is formatted outcome JSON including unsuccessful cancellation", async () => {
  const body = { ok: false, state: "error", message: "process may still be running" };
  respond = () => Response.json(body);
  expect(await run(["stop", "12"])).toEqual({
    exitCode: 1,
    stdout: `${JSON.stringify(body, null, 2)}\n`,
    stderr: "",
  });
  expect(requests).toHaveLength(1);
});
test("job syntax fails before HTTP and invalid files never start execution", async () => {
  for (const args of [
    [],
    ["get", "12"],
    ["start"],
    ["start", "7"],
    ["start", "7", "--file"],
    ["start", "7", "--file", "-", "--file", "-"],
    ["status", "12", "extra"],
    ["stop", "12", "--file", "-"],
    ...["0", "1.5", "9007199254740992", "bad"].map((id) => ["stop", id]),
  ]) {
    const result = await run([...args, "--json"], "{}");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(typeof JSON.parse(result.stderr).error).toBe("string");
  }
  expect(requests).toEqual([]);
  for (const body of ['{"command":"private-marker"', "[]", "null"]) {
    expect(await run(["start", "7", "--file", "-", "--json"], body)).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: '{"error":"Job file must contain a JSON object"}\n',
    });
  }
  expect(await run(["start", "7", "--file", join(directory, "missing"), "--json"])).toEqual({
    exitCode: 1,
    stdout: "",
    stderr: '{"error":"Unable to read job file"}\n',
  });
  expect((await run(["--bad", "--help"])).exitCode).toBe(0);
  expect(requests).toEqual([lookup, lookup, lookup, lookup]);
});
test("job start resolves the project before reading its file", async () => {
  projects = [];
  expect(await run(["start", "missing", "--file", join(directory, "absent"), "--json"])).toEqual({
    exitCode: 1,
    stdout: "",
    stderr: '{"error":"Project \\"missing\\" not found"}\n',
  });
  expect(requests).toEqual([lookup]);
});
test("job start checks configuration before reading its file", async () => {
  for (const key of ["MOOR_URL", "MOOR_API_KEY"]) {
    expect(
      await run(["start", "7", "--file", join(directory, "absent"), "--json"], "", { [key]: "" }),
    ).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: `${JSON.stringify({ error: `${key} is not set` })}\n`,
    });
  }
  expect(requests).toEqual([]);
});
test("job missing/malformed project lookup never starts execution", async () => {
  for (const value of [[], {}, [{ id: 0, name: "7" }]]) {
    requests.length = 0;
    projects = value;
    const result = await run(["start", "7", "--file", "-", "--json"], '{"command":"echo"}');
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(requests).toEqual([lookup]);
  }
});
test("job HTTP errors preserve server outcome and do not retry", async () => {
  for (const status of [400, 404, 409, 503]) {
    requests.length = 0;
    const body = { ok: false, state: "not_running", message: "cannot stop" };
    respond = () => Response.json(body, { status });
    const result = await run(["stop", "12", "--json"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({ ...body, status });
    expect(requests).toHaveLength(1);
  }
});
test("job start and stop reject unusable success responses without a retry", async () => {
  for (const verb of ["start", "stop"]) {
    for (const body of [null, {}, { run_id: 0 }, { run_id: "12", ok: "false" }]) {
      requests.length = 0;
      respond = () => Response.json(body);
      const result = await run(
        [
          verb,
          verb === "start" ? "7" : "12",
          ...(verb === "start" ? ["--file", "-"] : []),
          "--json",
        ],
        '{"command":"echo"}',
      );
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr).error).toContain(`Invalid job ${verb} response`);
      expect(requests).toHaveLength(verb === "start" ? 2 : 1);
    }
  }
});
