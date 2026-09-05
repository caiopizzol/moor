import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";

let server: ReturnType<typeof Bun.serve>;
const requests: Array<{ path: string; method: string; auth: string | null; body: unknown }> = [];
let respond: () => Response;
const summary = {
  action: "created",
  project_id: 8,
  project_name: "db",
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

test("deploy sends repeated volume flags in one authenticated request and preserves JSONL", async () => {
  expect(
    await run([
      "--volume",
      "data:/var/lib/db",
      "db",
      "--docker-image",
      "postgres:17",
      "--volume",
      "cache:/cache",
      "--no-run",
      "--update-existing",
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
      body: {
        name: "db",
        docker_image: "postgres:17",
        volumes: [
          { name: "data", target: "/var/lib/db" },
          { name: "cache", target: "/cache" },
        ],
        run: false,
        update_existing: true,
      },
    },
  ]);
});

test("deploy rejects malformed volume syntax without contacting the server", async () => {
  for (const value of ["data", ":/data", "data:", "data:relative"]) {
    expect(await run(["db", "--volume", value, "--json"])).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: `${JSON.stringify({ error: "--volume requires <name>:<absolute-container-path>" })}\n`,
    });
  }
  expect(await run(["db", "--volume", "--json"])).toEqual({
    exitCode: 1,
    stdout: "",
    stderr: '{"error":"--volume requires a value"}\n',
  });
  expect(requests).toEqual([]);
});

test("deploy rejects Docker-style mount modes rather than creating a literal target", async () => {
  for (const value of ["data:/data:ro", "data:/data:rw", "data:/data:v1"]) {
    expect(await run(["db", "--volume", value, "--json"])).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: '{"error":"--volume does not support mount modes or colons in targets"}\n',
    });
  }
  expect(requests).toEqual([]);
});

test("deploy preserves server volume conflicts and exits nonzero", async () => {
  respond = () => Response.json({ error: "existing target differs" }, { status: 409 });
  expect(
    await run([
      "db",
      "--volume",
      "data:/old",
      "--volume",
      "data:/new",
      "--update-existing",
      "--json",
    ]),
  ).toEqual({
    exitCode: 1,
    stdout: "",
    stderr: '{"error":"existing target differs","status":409}\n',
  });
  expect(requests).toHaveLength(1);
});

test("deploy help advertises repeatable volume input without a request", async () => {
  const result = await run(["--help"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("--volume <name>:<target>");
  expect(result.stdout).toContain("repeatable");
  expect(result.stderr).toBe("");
  expect(requests).toEqual([]);
});
