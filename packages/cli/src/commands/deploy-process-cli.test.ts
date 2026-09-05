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
test("deploy forwards exact process argv in one request without shell expansion", async () => {
  const command = ["worker.js", "two words", "$TOKEN", "$(uname)", "", "--json"];
  expect(
    await run([
      "--entrypoint",
      '["node"]',
      "worker",
      "--command",
      JSON.stringify(command),
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
      body: { name: "worker", command, entrypoint: ["node"], update_existing: true, run: false },
    },
  ]);
});
test("deploy preserves explicit null and empty process arrays and human output", async () => {
  for (const value of ["null", "[]"]) {
    requests.length = 0;
    expect(
      await run([
        "worker",
        "--command",
        value,
        "--entrypoint",
        value,
        "--update-existing",
        "--no-run",
      ]),
    ).toEqual({ exitCode: 0, stdout: "Updated project worker (id=8).\n", stderr: "" });
    expect(requests).toEqual([
      {
        path: "/api/deploy",
        method: "POST",
        auth: "Bearer test-key",
        body: {
          name: "worker",
          command: JSON.parse(value),
          entrypoint: JSON.parse(value),
          update_existing: true,
          run: false,
        },
      },
    ]);
  }
});
test("deploy keeps omitted process fields absent on updates", async () => {
  for (const flags of [[], ["--command", '["worker"]'], ["--entrypoint", '["node"]']]) {
    requests.length = 0;
    expect(
      (await run(["worker", "--update-existing", "--no-run", "--json", ...flags])).exitCode,
    ).toBe(0);
    expect(requests).toEqual([
      {
        path: "/api/deploy",
        method: "POST",
        auth: "Bearer test-key",
        body: {
          name: "worker",
          update_existing: true,
          run: false,
          ...(flags[0] === "--command"
            ? { command: ["worker"] }
            : flags[0] === "--entrypoint"
              ? { entrypoint: ["node"] }
              : {}),
        },
      },
    ]);
  }
});
test("deploy rejects malformed and duplicate process flags before any request", async () => {
  for (const flag of ["--command", "--entrypoint"]) {
    for (const value of ['["private-value"', '"private-value"', "{}", "true", "42"]) {
      expect(await run(["worker", flag, value, "--json"])).toEqual({
        exitCode: 1,
        stdout: "",
        stderr: `${JSON.stringify({ error: `${flag} must be a JSON array or null` })}\n`,
      });
    }
    expect(await run(["worker", flag, "--json"])).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: `${JSON.stringify({ error: `${flag} requires a value` })}\n`,
    });
    expect(await run(["worker", flag, "null", flag, "[]", "--json"])).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: `${JSON.stringify({ error: `${flag} may be used only once` })}\n`,
    });
  }
  expect(requests).toEqual([]);
});
test("deploy leaves process item validation on the server and retains its error", async () => {
  for (const field of ["command", "entrypoint"]) {
    requests.length = 0;
    respond = () =>
      Response.json({ error: `${field} entries must all be strings` }, { status: 400 });
    expect(await run(["worker", `--${field}`, "[1]", "--json"])).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: `${JSON.stringify({ error: `${field} entries must all be strings`, status: 400 })}\n`,
    });
    expect(requests).toEqual([
      {
        path: "/api/deploy",
        method: "POST",
        auth: "Bearer test-key",
        body: { name: "worker", [field]: [1] },
      },
    ]);
  }
});
