import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let directory: string;
let manifest: string;
let server: ReturnType<typeof Bun.serve>;
let respond: () => Response;
const requests: Array<{ path: string; method: string; auth: string | null; body: unknown }> = [];
const files = [
  { path: "/etc/app/config.json", content: '{"key":"private-fixture"}', mode: "0600" },
  { path: "/etc/app/token", env_ref: "TOKEN" },
];
const summary = {
  action: "updated",
  project_id: 8,
  project_name: "app",
  env_keys: [],
  run: false,
  env_changes_pending_restart: false,
};
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "moor-deploy-files-"));
  manifest = join(directory, "files.json");
  await writeFile(manifest, JSON.stringify(files));
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
  await rm(directory, { recursive: true, force: true });
});
async function run(args: string[], stdin = "") {
  const child = Bun.spawn({
    cmd: [process.execPath, join(import.meta.dir, "../index.ts"), "project", "deploy", ...args],
    env: { ...process.env, MOOR_URL: server.url.origin, MOOR_API_KEY: "test-key" },
    stdin: new Blob([stdin]),
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

test("deploy reads a disk file manifest and env stdin into one authenticated request", async () => {
  expect(
    await run(
      ["app", "--files", manifest, "--env-file", "-", "--no-run", "--update-existing", "--json"],
      '{"TOKEN":"env-fixture"}',
    ),
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
        name: "app",
        files,
        env: { TOKEN: "env-fixture" },
        run: false,
        update_existing: true,
      },
    },
  ]);
});

test("deploy accepts a file manifest on stdin without echoing content in human output", async () => {
  expect(await run(["app", "--files", "-", "--no-run"], JSON.stringify(files))).toEqual({
    exitCode: 0,
    stdout: "Updated project app (id=8).\n",
    stderr: "",
  });
  expect(requests[0]?.body).toEqual({ name: "app", files, run: false });
});

test("deploy rejects invalid manifest JSON without echoing secret contents or making requests", async () => {
  for (const value of ['{"secret":"private-fixture"', "{}", "null", '"private-fixture"']) {
    expect(await run(["app", "--files", "-", "--json"], value)).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: '{"error":"Failed to read --files: expected a JSON array of file entries"}\n',
    });
  }
  expect(requests).toEqual([]);
});

test("deploy rejects two stdin readers and duplicate or missing files options before requests", async () => {
  for (const args of [
    ["--files", "-", "--env-file", "-"],
    ["--env-file", "-", "--files", "-"],
    ["--files", manifest, "--files", manifest],
    ["--files"],
  ]) {
    const result = await run(["app", ...args, "--json"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr).error).toMatch(
      /cannot both read stdin|may be used only once|requires a value/,
    );
  }
  expect(requests).toEqual([]);
});

test("deploy reports a missing manifest without making requests", async () => {
  const result = await run(["app", "--files", join(directory, "missing.json"), "--json"]);
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(JSON.parse(result.stderr).error).toContain("Failed to read --files:");
  expect(requests).toEqual([]);
});

test("deploy leaves entry validation to the API and preserves its error", async () => {
  respond = () => Response.json({ error: "each file must be an object" }, { status: 400 });
  expect(await run(["app", "--files", "-", "--json"], "[null]")).toEqual({
    exitCode: 1,
    stdout: "",
    stderr: '{"error":"each file must be an object","status":400}\n',
  });
  expect(requests[0]?.body).toEqual({ name: "app", files: [null] });
  expect(requests).toHaveLength(1);
});
