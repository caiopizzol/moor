// Integration tests for #37: GET /api/projects/:id/runs?include_output=false
// strips stdout/stderr and adds byte counts. The detail route (GET /api/runs/:id)
// always returns full payload — exercised separately so callers explicitly
// choose between cheap-list and full-detail.

process.env.MOOR_DB_PATH = ":memory:";

import { beforeEach, describe, expect, test } from "bun:test";

const { default: db } = await import("../db");
const { BuildRun, activeBuildRuns } = await import("../build-runs");
const { handleRuns } = await import("./runs");

async function call(method: string, path: string): Promise<Response> {
  const req = new Request(`http://localhost${path}`, { method });
  const res = await handleRuns(req, new URL(req.url));
  if (!res) throw new Error(`handleRuns returned null for ${method} ${path}`);
  return res;
}

function makeProject(name: string): number {
  return (
    db.query("INSERT INTO projects (name) VALUES (?) RETURNING id").get(name) as { id: number }
  ).id;
}

function makeCron(projectId: number, name: string): number {
  return (
    db
      .query(
        "INSERT INTO crons (project_id, name, schedule, command) VALUES (?, ?, '* * * * *', 'echo hi') RETURNING id",
      )
      .get(projectId, name) as { id: number }
  ).id;
}

function makeRun(
  projectId: number,
  opts: { cronId?: number | null; stdout?: string; stderr?: string; exitCode?: number | null } = {},
): number {
  return (
    db
      .query(
        `INSERT INTO runs (project_id, cron_id, started_at, finished_at, exit_code, stdout, stderr, duration_ms)
         VALUES (?, ?, datetime('now'), datetime('now'), ?, ?, ?, ?)
         RETURNING id`,
      )
      .get(
        projectId,
        opts.cronId ?? null,
        opts.exitCode ?? 0,
        opts.stdout ?? "",
        opts.stderr ?? "",
        100,
      ) as { id: number }
  ).id;
}

describe("#37 GET /api/projects/:id/runs include_output flag", () => {
  beforeEach(() => {
    db.query("DELETE FROM runs").run();
    db.query("DELETE FROM crons").run();
    db.query("DELETE FROM projects").run();
  });

  test("default (no flag) returns full stdout/stderr — preserves UI contract", async () => {
    const pid = makeProject("a");
    makeRun(pid, { stdout: "hello world", stderr: "" });
    const res = await call("GET", `/api/projects/${pid}/runs`);
    const body = (await res.json()) as { runs: Array<{ stdout: string }>; total: number };
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0].stdout).toBe("hello world");
  });

  test("include_output=true behaves like the default", async () => {
    const pid = makeProject("a");
    makeRun(pid, { stdout: "abc" });
    const res = await call("GET", `/api/projects/${pid}/runs?include_output=true`);
    const body = (await res.json()) as { runs: Array<{ stdout: string }> };
    expect(body.runs[0].stdout).toBe("abc");
  });

  test("include_output=false strips stdout/stderr and returns *_bytes counts", async () => {
    const pid = makeProject("a");
    const bigStdout = "x".repeat(50_000);
    const bigStderr = "y".repeat(1_000);
    makeRun(pid, { stdout: bigStdout, stderr: bigStderr });
    const res = await call("GET", `/api/projects/${pid}/runs?include_output=false`);
    const body = (await res.json()) as {
      runs: Array<Record<string, unknown>>;
      total: number;
    };
    expect(body.runs).toHaveLength(1);
    const row = body.runs[0];
    expect(row.stdout).toBeUndefined();
    expect(row.stderr).toBeUndefined();
    expect(row.stdout_bytes).toBe(50_000);
    expect(row.stderr_bytes).toBe(1_000);
    // Other useful fields still present
    expect(row.id).toBeDefined();
    expect(row.exit_code).toBe(0);
    expect(row.started_at).toBeDefined();
    expect(row.finished_at).toBeDefined();
  });

  test("multibyte stdout reports UTF-8 byte count, not char count", async () => {
    // SQLite length(TEXT) counts characters; we need bytes so callers can
    // budget agent token windows accurately. "é🙂" = 2 chars but 6 bytes.
    const pid = makeProject("a");
    makeRun(pid, { stdout: "é🙂" });
    const res = await call("GET", `/api/projects/${pid}/runs?include_output=false`);
    const body = (await res.json()) as { runs: Array<{ stdout_bytes: number }> };
    expect(body.runs[0].stdout_bytes).toBe(6);
  });

  test("running run with NULL stdout/stderr reports 0 bytes, not null", async () => {
    // A still-running cron has stdout/stderr = NULL. length(NULL) is NULL in
    // SQLite — without COALESCE the MCP table would render "stdout=nullB".
    const pid = makeProject("a");
    db.query(
      `INSERT INTO runs (project_id, cron_id, started_at, exit_code, stdout, stderr, duration_ms)
       VALUES (?, NULL, datetime('now'), NULL, NULL, NULL, NULL)`,
    ).run(pid);
    const res = await call("GET", `/api/projects/${pid}/runs?include_output=false`);
    const body = (await res.json()) as {
      runs: Array<{ stdout_bytes: number; stderr_bytes: number }>;
    };
    expect(body.runs[0].stdout_bytes).toBe(0);
    expect(body.runs[0].stderr_bytes).toBe(0);
  });

  test("list joins cron name/command for cron runs", async () => {
    const pid = makeProject("a");
    const cid = makeCron(pid, "nightly");
    makeRun(pid, { cronId: cid });
    const res = await call("GET", `/api/projects/${pid}/runs?include_output=false`);
    const body = (await res.json()) as { runs: Array<{ cron_name: string; cron_command: string }> };
    expect(body.runs[0].cron_name).toBe("nightly");
    expect(body.runs[0].cron_command).toBe("echo hi");
  });

  test("deleted cron leaves cron_id NULL on its old runs (SET NULL semantics)", async () => {
    const pid = makeProject("a");
    const cid = makeCron(pid, "soon-deleted");
    makeRun(pid, { cronId: cid });
    db.query("DELETE FROM crons WHERE id = ?").run(cid);
    const res = await call("GET", `/api/projects/${pid}/runs?include_output=false`);
    const body = (await res.json()) as {
      runs: Array<{ cron_id: number | null; cron_name: string | null }>;
    };
    expect(body.runs[0].cron_id).toBeNull();
    expect(body.runs[0].cron_name).toBeNull();
    // From this row alone we cannot tell "build" from "orphaned cron run".
    // MCP labels the ambiguous case honestly rather than confidently as "build".
  });

  test("detail route /api/runs/:id always returns full payload regardless of list flag", async () => {
    const pid = makeProject("a");
    const rid = makeRun(pid, { stdout: "full output here" });
    const res = await call("GET", `/api/runs/${rid}`);
    const body = (await res.json()) as { stdout: string };
    expect(body.stdout).toBe("full output here");
  });
});

describe("#65 list orders by started_at_ms with id tie-breaker", () => {
  beforeEach(() => {
    db.query("DELETE FROM runs").run();
    db.query("DELETE FROM projects").run();
  });

  test("two builds in the same wall-clock second sort by started_at_ms DESC", async () => {
    // SQLite started_at is second-precision, so back-to-back builds collide.
    // moor_rebuild tells agents to use the most recent in-flight build —
    // ordering must be unambiguous.
    const pid = makeProject("a");
    const earlier = db
      .query(
        `INSERT INTO runs (project_id, cron_id, started_at, started_at_ms, finished_at, exit_code, stdout)
         VALUES (?, NULL, datetime('now'), 1000, datetime('now'), 0, '')
         RETURNING id`,
      )
      .get(pid) as { id: number };
    const later = db
      .query(
        `INSERT INTO runs (project_id, cron_id, started_at, started_at_ms, finished_at, exit_code, stdout)
         VALUES (?, NULL, datetime('now'), 2000, datetime('now'), 0, '')
         RETURNING id`,
      )
      .get(pid) as { id: number };

    const res = await call("GET", `/api/projects/${pid}/runs?include_output=false`);
    const body = (await res.json()) as { runs: Array<{ id: number }> };
    expect(body.runs.map((r) => r.id)).toEqual([later.id, earlier.id]);
  });

  test("identical started_at_ms falls back to id DESC", async () => {
    const pid = makeProject("a");
    const first = db
      .query(
        `INSERT INTO runs (project_id, cron_id, started_at, started_at_ms, finished_at, exit_code, stdout)
         VALUES (?, NULL, datetime('now'), 5000, datetime('now'), 0, '')
         RETURNING id`,
      )
      .get(pid) as { id: number };
    const second = db
      .query(
        `INSERT INTO runs (project_id, cron_id, started_at, started_at_ms, finished_at, exit_code, stdout)
         VALUES (?, NULL, datetime('now'), 5000, datetime('now'), 0, '')
         RETURNING id`,
      )
      .get(pid) as { id: number };

    const res = await call("GET", `/api/projects/${pid}/runs?include_output=false`);
    const body = (await res.json()) as { runs: Array<{ id: number }> };
    expect(body.runs.map((r) => r.id)).toEqual([second.id, first.id]);
  });
});

describe("#68 POST /api/runs/:id/stop dispatch", () => {
  beforeEach(() => {
    db.query("DELETE FROM runs").run();
    db.query("DELETE FROM projects").run();
    // Active registry persists across tests in the same module; clear so
    // each test starts from a known state.
    activeBuildRuns.clear();
  });

  test("active build run → 200 { ok:true, result:'cancelled' } and row finalized exit=130", async () => {
    const pid = makeProject("a");
    const run = new BuildRun(pid);

    const res = await call("POST", `/api/runs/${run.id}/stop`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; result: string };
    expect(body).toEqual({ ok: true, result: "cancelled" });
    expect(run.abort.signal.aborted).toBe(true);

    const row = db.query("SELECT exit_code, stderr FROM runs WHERE id = ?").get(run.id) as {
      exit_code: number;
      stderr: string;
    };
    expect(row.exit_code).toBe(130);
    expect(row.stderr).toContain("[cancelled by user]");
  });

  test("active build past markStreamingDone → 409 { ok:false, result:'not_cancellable' }", async () => {
    const pid = makeProject("a");
    const run = new BuildRun(pid);
    run.markStreamingDone();

    const res = await call("POST", `/api/runs/${run.id}/stop`);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { ok: boolean; result: string };
    expect(body).toEqual({ ok: false, result: "not_cancellable" });
    // Row still in-flight; container-start path would finalize later.
    const row = db.query("SELECT finished_at FROM runs WHERE id = ?").get(run.id) as {
      finished_at: string | null;
    };
    expect(row.finished_at).toBeNull();
    run.finalize(0); // cleanup
  });

  test("finished row → 409 { ok:false, result:'already_finished' }", async () => {
    const pid = makeProject("a");
    const rid = (
      db
        .query(
          `INSERT INTO runs (project_id, cron_id, started_at, finished_at, exit_code, stdout)
           VALUES (?, NULL, datetime('now'), datetime('now'), 0, '') RETURNING id`,
        )
        .get(pid) as { id: number }
    ).id;

    const res = await call("POST", `/api/runs/${rid}/stop`);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { ok: boolean; result: string };
    expect(body).toEqual({ ok: false, result: "already_finished" });
  });

  test("missing row → 404 { ok:false, result:'not_found' }", async () => {
    const res = await call("POST", `/api/runs/999999/stop`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { ok: boolean; result: string };
    expect(body).toEqual({ ok: false, result: "not_found" });
  });

  test("unfinished row not in active registry → 409 { ok:false, result:'not_active' }", async () => {
    // Simulates an orphan row from a prior moor process that the startup
    // sweep would have caught on next restart. The route should refuse to
    // cancel rather than try to finalize something it can't observe.
    const pid = makeProject("a");
    const rid = (
      db
        .query(
          `INSERT INTO runs (project_id, cron_id, started_at)
           VALUES (?, NULL, datetime('now')) RETURNING id`,
        )
        .get(pid) as { id: number }
    ).id;

    const res = await call("POST", `/api/runs/${rid}/stop`);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { ok: boolean; result: string };
    expect(body).toEqual({ ok: false, result: "not_active" });
  });

  test("active cron run → 200 { ok:true, result:'cancelled_cron' }", async () => {
    // cron.ts exports activeRuns; we populate it directly so stopCronRun()
    // takes the truthy path without setting up the full cron tick.
    // execId='' is falsy → stopCronRun skips killExec (no real Docker call).
    const { activeRuns } = await import("../cron");
    const pid = makeProject("a");
    const cron = db
      .query(
        `INSERT INTO crons (project_id, name, schedule, command)
         VALUES (?, 'nightly', '* * * * *', 'echo') RETURNING id`,
      )
      .get(pid) as { id: number };
    const rid = (
      db
        .query(
          `INSERT INTO runs (project_id, cron_id, started_at)
           VALUES (?, ?, datetime('now')) RETURNING id`,
        )
        .get(pid, cron.id) as { id: number }
    ).id;

    const controller = new AbortController();
    activeRuns.set(rid, { controller, execId: "" });

    const res = await call("POST", `/api/runs/${rid}/stop`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; result: string };
    expect(body).toEqual({ ok: true, result: "cancelled_cron" });
    expect(controller.signal.aborted).toBe(true);
    activeRuns.delete(rid);
  });
});
