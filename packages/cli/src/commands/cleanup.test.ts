import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const candidates = [
  { category: "build_cache", label: "caution", reclaimable_bytes: 10 },
  {
    category: "dangling_image",
    id: "sha256:test",
    label: "safe",
    reclaimable_bytes: 20,
    repo_tags: [],
  },
];
const plan = { candidates, total_reclaimable_bytes: 30 };
const success = {
  audit_id: 7,
  results: [
    { category: "build_cache", reclaimed_bytes: 9, error: null },
    { category: "dangling_image", id: "sha256:test", reclaimed_bytes: 20, error: null },
  ],
  total_reclaimed_bytes: 29,
};
let server: ReturnType<typeof Bun.serve>;
let response: () => Response;
let directory: string;
const requests: Array<{ path: string; method: string; auth: string | null; body: unknown }> = [];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "moor-cleanup-cli-"));
  requests.length = 0;
  response = () => Response.json(plan);
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
      return response();
    },
  });
});
afterEach(async () => {
  await server.stop(true);
  await rm(directory, { recursive: true, force: true });
});
async function run(args: string[], input = "", configured = true) {
  const child = Bun.spawn({
    cmd: [process.execPath, join(import.meta.dir, "../index.ts"), "server", ...args],
    env: {
      ...process.env,
      MOOR_URL: configured ? server.url.origin : "",
      MOOR_API_KEY: "test-key",
    },
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

test("cleanup plan makes one non-executing authenticated request in both modes", async () => {
  for (const json of [true, false]) {
    expect(await run([...(json ? ["--json"] : []), "cleanup", "plan"])).toEqual({
      exitCode: 0,
      stdout: `${JSON.stringify(plan, null, json ? undefined : 2)}\n`,
      stderr: "",
    });
  }
  expect(requests).toEqual(
    Array(2).fill({
      path: "/api/server/cleanup/plan",
      method: "POST",
      auth: "Bearer test-key",
      body: {},
    }),
  );
});

test("cleanup execute forwards reviewed disk and stdin files without planning or retrying", async () => {
  response = () => Response.json(success);
  const file = join(directory, "plan.json");
  await writeFile(file, JSON.stringify(plan));
  for (const source of [file, "-"]) {
    expect(
      await run(["cleanup", "execute", "--file", source, "--json"], JSON.stringify(plan)),
    ).toEqual({ exitCode: 0, stdout: `${JSON.stringify(success)}\n`, stderr: "" });
  }
  expect(requests).toEqual(
    Array(2).fill({
      path: "/api/server/cleanup/execute",
      method: "POST",
      auth: "Bearer test-key",
      body: plan,
    }),
  );
});

test("cleanup preserves partial results on stdout and exits one for any candidate failure", async () => {
  const partial = {
    ...success,
    results: [
      success.results[0],
      { ...success.results[1], error: "no longer dangling; skipped", reclaimed_bytes: 0 },
    ],
    total_reclaimed_bytes: 9,
  };
  response = () => Response.json(partial);
  for (const json of [true, false]) {
    expect(
      await run(
        ["cleanup", "execute", "--file", "-", ...(json ? ["--json"] : [])],
        JSON.stringify(plan),
      ),
    ).toEqual({
      exitCode: 1,
      stdout: `${JSON.stringify(partial, null, json ? undefined : 2)}\n`,
      stderr: "",
    });
  }
  expect(requests).toHaveLength(2);
});

test("cleanup syntax and config preflight precede file reads and HTTP", async () => {
  for (const args of [
    [],
    ["bogus"],
    ["plan", "extra"],
    ["execute"],
    ["plan", "--file", "-"],
    ["execute", "--file"],
    ["execute", "--file", "-", "--file", "-"],
    ["execute", "--file", "-", "extra"],
    ["execute", "--all"],
    ["execute", "--file", "--help"],
  ]) {
    const result = await run(["cleanup", ...args, "--json"], "not JSON");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr).error).not.toContain("Cleanup file");
  }
  const config = await run(
    ["cleanup", "execute", "--file", "/does-not-exist", "--json"],
    "",
    false,
  );
  expect(JSON.parse(config.stderr).error).toBe("MOOR_URL is not set");
  expect(config.exitCode).toBe(1);
  expect(requests).toEqual([]);
});

test("cleanup file envelope validation fails before deletion requests", async () => {
  for (const input of [
    "bad",
    "null",
    "[]",
    "{}",
    '{"candidates":[]}',
    '{"candidates":[null]}',
    '{"candidates":[[]]}',
  ]) {
    const result = await run(["cleanup", "execute", "--file", "-", "--json"], input);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr).error).toContain("nonempty candidates array");
  }
  const unreadable = await run([
    "cleanup",
    "execute",
    "--file",
    join(directory, "missing"),
    "--json",
  ]);
  expect(JSON.parse(unreadable.stderr).error).toBe("Unable to read cleanup file");
  expect(requests).toEqual([]);
});

test("cleanup API errors preserve details and never retry or claim success", async () => {
  response = () => Response.json({ error: "audit failed", code: "DB_ERROR" }, { status: 500 });
  for (const verb of ["plan", "execute"]) {
    const result = await run(
      ["cleanup", verb, ...(verb === "execute" ? ["--file", "-"] : []), "--json"],
      JSON.stringify(plan),
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      error: "audit failed",
      code: "DB_ERROR",
      status: 500,
    });
  }
  expect(requests).toHaveLength(2);
});

test("cleanup rejects malformed or incomplete execute outcomes", async () => {
  for (const payload of [
    null,
    {},
    { ...success, audit_id: 0 },
    { ...success, total_reclaimed_bytes: -1 },
    { ...success, results: [] },
    { ...success, results: [success.results[0]] },
    { ...success, results: [success.results[0], { ...success.results[1], id: "wrong" }] },
    { ...success, results: [success.results[0], { ...success.results[1], error: false }] },
    { ...success, results: [success.results[0], { ...success.results[1], reclaimed_bytes: -1 }] },
  ]) {
    response = () => Response.json(payload);
    const result = await run(["cleanup", "execute", "--file", "-", "--json"], JSON.stringify(plan));
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr).error).toContain("Partial deletion may have occurred");
  }
});

test("cleanup accepts empty plans but rejects malformed plans and invalid JSON", async () => {
  response = () => Response.json({ candidates: [], total_reclaimable_bytes: 0 });
  expect((await run(["cleanup", "plan", "--json"])).exitCode).toBe(0);
  for (const payload of [
    null,
    {},
    { candidates: [null], total_reclaimable_bytes: 0 },
    { candidates: [], total_reclaimable_bytes: "0" },
  ]) {
    response = () => Response.json(payload);
    expect((await run(["cleanup", "plan", "--json"])).exitCode).toBe(1);
  }
  response = () => new Response("broken");
  const result = await run(["cleanup", "execute", "--file", "-", "--json"], JSON.stringify(plan));
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(typeof JSON.parse(result.stderr).error).toBe("string");
});

test("cleanup help wins over invalid arguments and warns about irreversible scope", async () => {
  const result = await run(["cleanup", "execute", "--unknown", "--help"]);
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("irreversibly");
  expect(result.stdout).toContain("not a fixed set or byte limit");
  expect(requests).toEqual([]);
});

test("cleanup rejects malformed category-specific plan candidates", async () => {
  for (const candidate of [
    {},
    { ...candidates[0], category: "volume" },
    { ...candidates[0], reclaimable_bytes: -1 },
    { ...candidates[0], label: "safe" },
    { ...candidates[1], id: "" },
    { ...candidates[1], repo_tags: [1] },
    { ...candidates[1], label: "caution" },
  ]) {
    response = () =>
      Response.json({
        candidates: [candidate],
        total_reclaimable_bytes: "reclaimable_bytes" in candidate ? candidate.reclaimable_bytes : 0,
      });
    const result = await run(["cleanup", "plan", "--json"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr).error).toContain("Invalid cleanup plan response");
  }
});

test("cleanup rejects inconsistent totals before printing success", async () => {
  response = () => Response.json({ ...success, total_reclaimed_bytes: 999 });
  const execute = await run(["cleanup", "execute", "--file", "-", "--json"], JSON.stringify(plan));
  expect(execute.exitCode).toBe(1);
  expect(execute.stdout).toBe("");
  expect(JSON.parse(execute.stderr).error).toContain("Partial deletion may have occurred");
  response = () => Response.json({ ...plan, total_reclaimable_bytes: 999 });
  const planned = await run(["cleanup", "plan", "--json"]);
  expect(planned.exitCode).toBe(1);
  expect(planned.stdout).toBe("");
});
