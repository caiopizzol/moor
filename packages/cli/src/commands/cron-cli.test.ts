import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let server: ReturnType<typeof Bun.serve>;
let directory: string;
let projects: unknown;
let respond: () => Response;
const requests: Array<{ path: string; method: string; auth: string | null; body: unknown }> = [];
const row = {
  id: 12,
  project_id: 8,
  name: "job",
  schedule: "0 3 * * *",
  command: 'printf "%s" "$VALUE"',
  enabled: 0,
  timeout_ms: 600000,
};
const lookup = { path: "/api/projects", method: "GET", auth: "Bearer test-key", body: null };
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "moor-cron-cli-"));
  requests.length = 0;
  projects = [
    { id: 7, name: "decoy" },
    { id: 8, name: "7" },
  ];
  respond = () => Response.json(row);
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
    cmd: [process.execPath, join(import.meta.dir, "../index.ts"), "cron", ...args],
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
test("cron run returns acceptance with one direct trigger request in either output mode", async () => {
  const body = { ok: true, run_id: 99 };
  respond = () => Response.json(body);
  for (const flags of [[], ["--json"]]) {
    requests.length = 0;
    expect(await run(["run", ...flags, "12"])).toEqual({
      exitCode: 0,
      stdout: `${JSON.stringify(body, null, flags.length ? undefined : 2)}\n`,
      stderr: "",
    });
    expect(requests).toEqual([
      { path: "/api/crons/12/run", method: "POST", auth: "Bearer test-key", body: {} },
    ]);
  }
});
test("cron run rejects invalid IDs and extra arguments before any request", async () => {
  for (const args of [
    ["12", "extra"],
    ["12", "--file", "-"],
    ["12", "--unknown"],
    ...["0", "-1", "1.5", "9007199254740992", "nope"].map((id) => [id]),
  ]) {
    const result = await run(["run", ...args, "--json"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(typeof JSON.parse(result.stderr).error).toBe("string");
  }
  expect(requests).toEqual([]);
});
test("cron run fails on HTTP errors without retrying", async () => {
  for (const status of [400, 404, 503]) {
    requests.length = 0;
    respond = () => Response.json({ error: "rejected" }, { status });
    expect(await run(["run", "12", "--json"])).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: `${JSON.stringify({ error: "rejected", status })}\n`,
    });
    expect(requests).toHaveLength(1);
  }
});
test("cron run rejects unusable acceptance without guessing an ID or retrying", async () => {
  for (const body of [
    null,
    [],
    {},
    { ok: false, run_id: 99 },
    ...[0, -1, 1.5, "99", 9007199254740992].map((run_id) => ({ ok: true, run_id })),
  ]) {
    requests.length = 0;
    respond = () => Response.json(body);
    const result = await run(["run", "12", "--json"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr).error).toContain(
      "request may have started a run, do not retry blindly",
    );
    expect(requests).toHaveLength(1);
  }
});
test("cron list uses exact name before numeric ID and preserves JSON results", async () => {
  respond = () => Response.json([row]);
  expect(await run(["list", "--json", "7"])).toEqual({
    exitCode: 0,
    stdout: `${JSON.stringify([row])}\n`,
    stderr: "",
  });
  expect(requests).toEqual([
    lookup,
    { path: "/api/projects/8/crons", method: "GET", auth: "Bearer test-key", body: null },
  ]);
});
test("cron create sends disabled input and shell bytes intact from stdin or disk", async () => {
  const body = { name: row.name, schedule: row.schedule, command: row.command, enabled: false };
  for (const file of ["-", join(directory, "cron.json")]) {
    requests.length = 0;
    if (file !== "-") await writeFile(file, JSON.stringify(body));
    expect(await run(["create", "7", "--file", file, "--json"], JSON.stringify(body))).toEqual({
      exitCode: 0,
      stdout: `${JSON.stringify(row)}\n`,
      stderr: "",
    });
    expect(requests).toEqual([
      lookup,
      { path: "/api/projects/8/crons", method: "POST", auth: "Bearer test-key", body },
    ]);
  }
});
test("cron update sends only the patch directly to its ID without triggering a run", async () => {
  const body = { enabled: false };
  expect(await run(["update", "--file", "-", "12", "--json"], JSON.stringify(body))).toEqual({
    exitCode: 0,
    stdout: `${JSON.stringify(row)}\n`,
    stderr: "",
  });
  expect(requests).toEqual([
    { path: "/api/crons/12", method: "PUT", auth: "Bearer test-key", body },
  ]);
});
test("cron human mode renders formatted JSON without claiming execution success", async () => {
  expect(await run(["update", "12", "--file", "-"], '{"enabled":false}')).toEqual({
    exitCode: 0,
    stdout: `${JSON.stringify(row, null, 2)}\n`,
    stderr: "",
  });
  expect(requests).toHaveLength(1);
});
test("cron invalid syntax makes no requests and invalid files never mutate", async () => {
  for (const args of [
    [],
    ["run"],
    ["delete", "12"],
    ["list"],
    ["list", "7", "extra"],
    ["list", "7", "--file", "-"],
    ["create", "7"],
    ["create", "7", "--file"],
    ["create", "7", "--file", "-", "--file", "-"],
    ["update", "0", "--file", "-"],
    ["update", "1.5", "--file", "-"],
    ["update", "9007199254740992", "--file", "-"],
  ]) {
    const result = await run([...args, "--json"], "{}");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(typeof JSON.parse(result.stderr).error).toBe("string");
  }
  expect(requests).toEqual([]);
  for (const input of ['{"private":"do-not-echo"', "null", "[]", "42"]) {
    expect(await run(["create", "7", "--file", "-", "--json"], input)).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: '{"error":"Cron file must contain a JSON object"}\n',
    });
  }
  expect(await run(["update", "12", "--file", join(directory, "missing"), "--json"])).toEqual({
    exitCode: 1,
    stdout: "",
    stderr: '{"error":"Unable to read cron file"}\n',
  });
  expect((await run(["create", "--bad", "--help"])).exitCode).toBe(0);
  expect(requests).toEqual([lookup, lookup, lookup, lookup]);
});
test("cron create resolves the project before reading its input file", async () => {
  projects = [];
  const result = await run(["create", "missing", "--file", join(directory, "absent"), "--json"]);
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(JSON.parse(result.stderr)).toEqual({ error: 'Project "missing" not found' });
  expect(requests).toEqual([lookup]);
});
test("cron create and update check configuration before reading input", async () => {
  for (const verb of ["create", "update"]) {
    for (const key of ["MOOR_URL", "MOOR_API_KEY"]) {
      const result = await run([verb, "12", "--file", join(directory, "absent"), "--json"], "", {
        [key]: "",
      });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr)).toEqual({ error: `${key} is not set` });
    }
  }
  expect(requests).toEqual([]);
});
test("cron missing or malformed projects cannot reach a mutation", async () => {
  for (const value of [[], [{ id: 0, name: "7" }], {}]) {
    requests.length = 0;
    projects = value;
    const result = await run(["create", "7", "--file", "-", "--json"], "{}");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(typeof JSON.parse(result.stderr).error).toBe("string");
    expect(requests).toEqual([lookup]);
  }
});
test("cron forwards validation errors and treats retrieval errors as failures", async () => {
  for (const verb of ["list", "create", "update"]) {
    requests.length = 0;
    respond = () => Response.json({ error: "rejected", code: "fixture" }, { status: 400 });
    const result = await run(
      [verb, verb === "update" ? "12" : "7", ...(verb === "list" ? [] : ["--file", "-"]), "--json"],
      '{"enabled":"invalid"}',
    );
    expect(result).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: '{"error":"rejected","code":"fixture","status":400}\n',
    });
    expect(requests).toHaveLength(verb === "update" ? 1 : 2);
    if (verb !== "list") expect(requests.at(-1)?.body).toEqual({ enabled: "invalid" });
  }
});
