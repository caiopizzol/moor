import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";

const status = {
  current: {
    version: "1.0",
    image_id: null,
    repo_digest: null,
    started_at: "2026-09-05T00:00:00Z",
  },
  available: {
    latest_tag: "latest",
    latest_digest: null,
    update_available: null,
    registry_error: "offline",
  },
  active_work: { builds_in_flight: 1, execs_in_flight: 0, crons_in_flight: 0, terminals_open: 0 },
  db_backup: { last_backup_at: null, age_seconds: null, location: null },
  safe_to_update: false,
  unsafe_reasons: ["Active build", "Registry unavailable"],
  recommended_command: "docker compose pull moor && docker compose up -d --no-deps --wait moor",
};
const row = {
  id: 3,
  started_at: "2026-09-05 00:00:00",
  started_at_ms: 1000,
  finished_at: null,
  finished_at_ms: null,
  duration_ms: null,
  state: "failed",
  from_digest: null,
  to_digest: null,
  prev_image_id: null,
  backup_path: null,
  rollback_error: null,
  error_log: "backup failed",
};
let server: ReturnType<typeof Bun.serve>;
let response: () => Response;
const requests: Array<{ path: string; method: string; auth: string | null; body: string }> = [];
beforeEach(() => {
  requests.length = 0;
  response = () => Response.json(status);
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      requests.push({
        path: url.pathname + url.search,
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

test("update status preserves unsafe and unknown readiness in both modes with one authenticated GET", async () => {
  for (const json of [true, false]) {
    expect(await run([...(json ? ["--json"] : []), "update", "status"])).toEqual({
      exitCode: 0,
      stdout: `${JSON.stringify(status, null, json ? undefined : 2)}\n`,
      stderr: "",
    });
  }
  expect(requests).toEqual(
    Array(2).fill({
      path: "/api/server/update-status",
      method: "GET",
      auth: "Bearer test-key",
      body: "",
    }),
  );
});

test("update status preserves safe readiness and extension fields", async () => {
  const payload = {
    ...status,
    safe_to_update: true,
    unsafe_reasons: [],
    future: "kept",
    available: { ...status.available, update_available: true },
  };
  response = () => Response.json(payload);
  expect(await run(["update", "--json", "status"])).toEqual({
    exitCode: 0,
    stdout: `${JSON.stringify(payload)}\n`,
    stderr: "",
  });
});

test("update audit returns all lifecycle states without treating remote failure as retrieval failure", async () => {
  const payload = {
    rows: ["in_progress", "success", "rolled_back", "rollback_failed", "failed", "crashed"].map(
      (state) => ({ ...row, state }),
    ),
  };
  response = () => Response.json(payload);
  for (const json of [true, false]) {
    expect(await run(["update", "audit", ...(json ? ["--json"] : [])])).toEqual({
      exitCode: 0,
      stdout: `${JSON.stringify(payload, null, json ? undefined : 2)}\n`,
      stderr: "",
    });
  }
  expect(requests).toEqual(
    Array(2).fill({
      path: "/api/server/update/audit",
      method: "GET",
      auth: "Bearer test-key",
      body: "",
    }),
  );
});

test("update audit forwards limit bounds and supports empty history", async () => {
  response = () => Response.json({ rows: [] });
  for (const limit of [1, 20, 200]) {
    expect(await run(["update", "--limit", String(limit), "audit", "--json"])).toEqual({
      exitCode: 0,
      stdout: '{"rows":[]}\n',
      stderr: "",
    });
    expect(requests.at(-1)?.path).toBe(`/api/server/update/audit?limit=${limit}`);
  }
  expect(requests).toHaveLength(3);
});

test("update inspection preserves signed wall-clock differences from the API", async () => {
  const payload = { ...status, db_backup: { ...status.db_backup, age_seconds: -5 } };
  response = () => Response.json(payload);
  expect(JSON.parse((await run(["update", "status", "--json"])).stdout)).toEqual(payload);
  const audit = { rows: [{ ...row, duration_ms: -1000, finished_at_ms: 0 }] };
  response = () => Response.json(audit);
  expect(JSON.parse((await run(["update", "audit", "--json"])).stdout)).toEqual(audit);
});

test("update rejects invalid syntax and limits before requests", async () => {
  const invalid = [
    [],
    ["apply"],
    ["status", "extra"],
    ["audit", "extra"],
    ["status", "--unknown"],
    ["status", "--limit", "1"],
    ["audit", "--limit", "1", "--limit", "2"],
    ...[undefined, "", " ", "0", "201", "1.5", "-1", "NaN", "Infinity", "--help", "-h"].map(
      (value) => ["audit", "--limit", ...(value === undefined ? [] : [value])],
    ),
  ];
  for (const args of invalid) {
    const result = await run(["update", ...args, "--json"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(typeof JSON.parse(result.stderr).error).toBe("string");
  }
  expect(requests).toEqual([]);
});

test("update help wins over invalid syntax outside value slots and makes no requests", async () => {
  for (const args of [
    ["--help"],
    ["audit", "extra", "-h"],
    ["audit", "--limit", "bad", "--help"],
  ]) {
    const result = await run(["update", ...args]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("moor server update audit");
    expect(result.stderr).toBe("");
  }
  expect(requests).toEqual([]);
});

test("update rejects malformed readiness and audit documents without success output", async () => {
  for (const [action, payloads] of [
    [
      "status",
      [
        null,
        {},
        { ...status, safe_to_update: "false" },
        { ...status, unsafe_reasons: [1] },
        { ...status, safe_to_update: true },
        { ...status, available: {} },
        { ...status, active_work: {} },
        { ...status, db_backup: {} },
      ],
    ],
    [
      "audit",
      [
        null,
        {},
        { rows: [null] },
        { rows: [{ ...row, id: 0 }] },
        { rows: [{ ...row, state: "bogus" }] },
        { rows: [{ ...row, error_log: 3 }] },
      ],
    ],
  ] as const) {
    for (const payload of payloads) {
      response = () => Response.json(payload);
      const result = await run(["update", action, "--json"]);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr).error).toBe(`Invalid update ${action} response`);
    }
  }
});

test("update reports HTTP and unreadable JSON errors in both modes without retries", async () => {
  for (const action of ["status", "audit"]) {
    for (const json of [true, false]) {
      for (const http of [true, false]) {
        response = () =>
          http
            ? Response.json({ error: "unavailable" }, { status: 503 })
            : new Response("not json");
        const before = requests.length;
        const result = await run(["update", action, ...(json ? ["--json"] : [])]);
        expect(result.exitCode).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr.length).toBeGreaterThan(0);
        if (json && http)
          expect(JSON.parse(result.stderr)).toEqual({ error: "unavailable", status: 503 });
        expect(requests.length).toBe(before + 1);
      }
    }
  }
});
