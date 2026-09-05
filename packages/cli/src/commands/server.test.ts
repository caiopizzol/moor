import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";

const state = {
  enabled: true,
  reason: "maintenance",
  started_at: "2026-09-05T10:00:00Z",
  expires_at: "2026-09-05T10:30:00Z",
  clear_after_version: null,
};
let server: ReturnType<typeof Bun.serve>;
let response: () => Response;
const requests: Array<{ path: string; method: string; auth: string | null; body: string }> = [];
beforeEach(() => {
  requests.length = 0;
  response = () => Response.json({ state });
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      requests.push({
        path: new URL(req.url).pathname,
        method: req.method,
        auth: req.headers.get("Authorization"),
        body: await req.text(),
      });
      return response();
    },
  });
});
afterEach(async () => {
  await server.stop(true);
});
async function run(args: string[]) {
  const child = Bun.spawn({
    cmd: [process.execPath, join(import.meta.dir, "../index.ts"), "server", ...args],
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

test("drain status preserves state and active work with one authenticated GET", async () => {
  const payload = {
    state,
    active_work: { builds_in_flight: 2, execs_in_flight: 1, crons_in_flight: 0, terminals_open: 1 },
  };
  response = () => Response.json(payload);
  expect(await run(["--json", "drain", "status"])).toEqual({
    exitCode: 0,
    stdout: `${JSON.stringify(payload)}\n`,
    stderr: "",
  });
  expect(requests).toEqual([
    { path: "/api/server/drain", method: "GET", auth: "Bearer test-key", body: "" },
  ]);
});

test("drain enable sends an empty object for server defaults without other actions", async () => {
  expect(await run(["drain", "enable", "--json"])).toEqual({
    exitCode: 0,
    stdout: `${JSON.stringify({ state })}\n`,
    stderr: "",
  });
  expect(requests).toEqual([
    { path: "/api/server/drain/enable", method: "POST", auth: "Bearer test-key", body: "{}" },
  ]);
});

test("drain enable forwards supplied values and leaves TTL clamping to the API", async () => {
  for (const ttl of [0.01, 2.5, 20000]) {
    expect(
      (
        await run([
          "drain",
          "--reason",
          "maintenance window",
          "enable",
          "--json",
          "--ttl-minutes",
          String(ttl),
        ])
      ).exitCode,
    ).toBe(0);
    expect(JSON.parse(requests.at(-1)?.body ?? "null")).toEqual({
      reason: "maintenance window",
      ttl_minutes: ttl,
    });
  }
  expect(requests).toHaveLength(3);
  expect((await run(["drain", "enable", "--reason", "maintenance"])).exitCode).toBe(0);
  expect(JSON.parse(requests.at(-1)?.body ?? "null")).toEqual({ reason: "maintenance" });
  expect((await run(["drain", "enable", "--ttl-minutes", "5"])).exitCode).toBe(0);
  expect(JSON.parse(requests.at(-1)?.body ?? "null")).toEqual({ ttl_minutes: 5 });
});

test("drain disable uses only its endpoint and renders disabled state in both modes", async () => {
  const payload = {
    state: {
      enabled: false,
      reason: null,
      started_at: null,
      expires_at: null,
      clear_after_version: null,
    },
  };
  response = () => Response.json(payload);
  for (const json of [true, false]) {
    expect(await run(["drain", "disable", ...(json ? ["--json"] : [])])).toEqual({
      exitCode: 0,
      stdout: `${JSON.stringify(payload, null, json ? undefined : 2)}\n`,
      stderr: "",
    });
  }
  expect(requests).toEqual(
    Array(2).fill({
      path: "/api/server/drain/disable",
      method: "POST",
      auth: "Bearer test-key",
      body: "{}",
    }),
  );
});

test("drain rejects invalid TTL before any request", async () => {
  for (const ttl of ["0", "-1", "NaN", "Infinity", "1e999", "", " ", "nope"]) {
    const result = await run(["drain", "enable", "--ttl-minutes", ttl, "--json"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr).error).toContain("finite positive number");
  }
  expect(requests).toEqual([]);
});

test("drain rejects missing, extra, unknown, duplicate, and action-inappropriate arguments before requests", async () => {
  for (const args of [
    [],
    ["drain"],
    ["drain", "bogus"],
    ["other", "status"],
    ["drain", "enable", "extra"],
    ["drain", "disable", "--unknown"],
    ["drain", "enable", "--reason"],
    ["drain", "enable", "--ttl-minutes"],
    ["drain", "enable", "--reason", "a", "--reason", "b"],
    ["drain", "enable", "--ttl-minutes", "2", "--ttl-minutes", "3"],
    ["drain", "status", "--ttl-minutes", "2"],
    ["drain", "disable", "--reason", "a"],
  ]) {
    const result = await run([...args, "--json"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(typeof JSON.parse(result.stderr).error).toBe("string");
  }
  const human = await run(["drain", "enable", "extra"]);
  expect(human.exitCode).toBe(1);
  expect(human.stderr).toStartWith("Error:");
  expect(requests).toEqual([]);
});

test("drain help wins over invalid arguments without requests", async () => {
  const result = await run(["drain", "enable", "--unknown", "--help"]);
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("moor server drain enable");
  expect(requests).toEqual([]);
});

test("drain does not treat reason values as successful help requests", async () => {
  const short = await run(["drain", "enable", "--reason", "-h", "--json"]);
  expect(short.exitCode).toBe(0);
  expect(JSON.parse(short.stdout)).toEqual({ state });
  expect(JSON.parse(requests.at(-1)?.body ?? "null")).toEqual({ reason: "-h" });
  const long = await run(["drain", "enable", "--reason", "--help", "--json"]);
  expect(long.exitCode).toBe(1);
  expect(long.stdout).toBe("");
  expect(JSON.parse(long.stderr).error).toContain("Missing value");
  expect(requests).toHaveLength(1);
});

test("all drain actions preserve API failure details and exit nonzero in both modes", async () => {
  response = () => Response.json({ error: "unavailable", hint: "try later" }, { status: 503 });
  for (const action of ["status", "enable", "disable"]) {
    for (const json of [true, false]) {
      const result = await run(["drain", action, ...(json ? ["--json"] : [])]);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      if (json)
        expect(JSON.parse(result.stderr)).toEqual({
          error: "unavailable",
          hint: "try later",
          status: 503,
        });
      else expect(result.stderr).toContain("unavailable");
    }
  }
  expect(requests).toHaveLength(6);
});

test("drain invalid JSON responses fail without success output", async () => {
  response = () => new Response("not json");
  const result = await run(["drain", "enable", "--json"]);
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(typeof JSON.parse(result.stderr).error).toBe("string");
  expect(requests).toHaveLength(1);
});
