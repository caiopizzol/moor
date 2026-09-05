import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";

let server: ReturnType<typeof Bun.serve>;
let respond: () => Response;
const requests: Array<{ path: string; method: string; auth: string | null; body: unknown }> = [];
const summary = {
  action: "updated",
  project_id: 8,
  project_name: "worker",
  env_keys: [],
  run: false,
  env_changes_pending_restart: false,
};
beforeEach(() => {
  requests.length = 0;
  respond = () =>
    new Response(`event: deploy\ndata: ${JSON.stringify(summary)}\n\n`, {
      headers: { "Content-Type": "text/event-stream" },
    });
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      requests.push({
        path: new URL(req.url).pathname,
        method: req.method,
        auth: req.headers.get("Authorization"),
        body: await req.json(),
      });
      return respond();
    },
  });
});
afterEach(async () => {
  await server.stop(true);
});
async function run(args: string[]) {
  const child = Bun.spawn({
    cmd: [process.execPath, join(import.meta.dir, "../index.ts"), "project", "deploy", ...args],
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
}
test("deploy sends memory and fractional CPU caps in one authenticated API request", async () => {
  expect(
    await run([
      "--cpus",
      "0.5",
      "worker",
      "--memory-limit-mb",
      "256",
      "--update-existing",
      "--no-run",
      "--json",
    ]),
  ).toEqual({
    exitCode: 0,
    stdout: `${JSON.stringify({ event: "deploy", data: summary })}\n`,
    stderr: "",
  });
  expect(requests).toEqual([
    {
      path: "/api/deploy",
      method: "POST",
      auth: "Bearer test-key",
      body: { name: "worker", cpus: 0.5, memory_limit_mb: 256, update_existing: true, run: false },
    },
  ]);
});
test("deploy maps unlimited to explicit null and retains human rendering", async () => {
  expect(
    await run([
      "worker",
      "--memory-limit-mb",
      "unlimited",
      "--cpus",
      "unlimited",
      "--update-existing",
      "--no-run",
    ]),
  ).toEqual({
    exitCode: 0,
    stdout: "Updated project worker (id=8).\n",
    stderr: "",
  });
  expect(requests[0]?.body).toEqual({
    name: "worker",
    memory_limit_mb: null,
    cpus: null,
    update_existing: true,
    run: false,
  });
});
test("deploy omits unspecified limits so updates retain existing configuration", async () => {
  expect((await run(["worker", "--update-existing", "--no-run", "--json"])).exitCode).toBe(0);
  expect(requests[0]?.body).toEqual({ name: "worker", update_existing: true, run: false });
});
test("deploy rejects invalid or repeated numeric limit options before requests", async () => {
  for (const option of ["--memory-limit-mb", "--cpus"]) {
    for (const value of ["0", "-1", "NaN", "Infinity", "garbage", "1e999"]) {
      const result = await run(["worker", option, value, "--json"]);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr).error).toContain(`${option} must be a positive`);
    }
    expect(await run(["worker", option, "1", option, "2", "--json"])).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: `${JSON.stringify({ error: `${option} may be used only once` })}\n`,
    });
    expect(await run(["worker", option, "--json"])).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: `${JSON.stringify({ error: `${option} requires a value` })}\n`,
    });
  }
  expect((await run(["worker", "--memory-limit-mb", "1.5", "--json"])).exitCode).toBe(1);
  expect(requests).toEqual([]);
});
test("deploy leaves host capacity validation to the server and forwards errors", async () => {
  respond = () => Response.json({ error: "cpus exceeds host core count" }, { status: 400 });
  expect(await run(["worker", "--cpus", "1000", "--json"])).toEqual({
    exitCode: 1,
    stdout: "",
    stderr: '{"error":"cpus exceeds host core count","status":400}\n',
  });
  expect(requests[0]?.body).toEqual({ name: "worker", cpus: 1000 });
  expect(requests).toHaveLength(1);
});
