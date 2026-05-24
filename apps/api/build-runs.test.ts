// Integration tests for #65 BuildRun lifecycle and the orphan-sweep
// migration. Runs against in-memory SQLite (MOOR_DB_PATH set before db.ts
// loads). The 1-second flush timer is observed indirectly via finalize(),
// which always writes the latest tail.

process.env.MOOR_DB_PATH = ":memory:";

import { beforeEach, describe, expect, test } from "bun:test";

const { default: db } = await import("./db");
const { BuildRun, activeBuildRuns, interruptActiveBuildRuns } = await import("./build-runs");
const { TAIL_CAP_BYTES } = await import("./output-cap");

function makeProject(name = "p"): number {
  return (
    db.query("INSERT INTO projects (name) VALUES (?) RETURNING id").get(name) as { id: number }
  ).id;
}

describe("#65 schema migration", () => {
  beforeEach(() => {
    db.query("DELETE FROM runs").run();
    db.query("DELETE FROM projects").run();
  });

  test("runs table has the new columns", () => {
    const cols = db.query("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    expect(names.has("started_at_ms")).toBe(true);
    expect(names.has("finished_at_ms")).toBe(true);
    expect(names.has("stdout_total_bytes")).toBe(true);
    expect(names.has("stderr_total_bytes")).toBe(true);
  });
});

describe("#65 BuildRun lifecycle", () => {
  let projectId: number;

  beforeEach(() => {
    db.query("DELETE FROM runs").run();
    db.query("DELETE FROM projects").run();
    projectId = makeProject();
  });

  test("INSERTs a row at construction with finished_at NULL — visible to moor_run_get mid-build", () => {
    const run = new BuildRun(projectId);
    const row = db.query("SELECT * FROM runs WHERE id = ?").get(run.id) as {
      finished_at: string | null;
      cron_id: number | null;
      started_at_ms: number | null;
      stdout: string;
      stdout_total_bytes: number;
    };
    expect(row.finished_at).toBeNull();
    expect(row.cron_id).toBeNull();
    expect(row.started_at_ms).toBeGreaterThan(0);
    expect(row.stdout).toBe("");
    expect(row.stdout_total_bytes).toBe(0);
    run.finalize(0);
  });

  test("finalize captures the latest tail and totals — no append lost between flush ticks", () => {
    const run = new BuildRun(projectId);
    run.appendStdout("Step 1/3 : FROM node:20\n");
    run.appendStdout("Step 2/3 : RUN apt-get install\n");
    run.appendStderr("warning: deprecated flag\n");
    run.finalize(0);

    const row = db.query("SELECT * FROM runs WHERE id = ?").get(run.id) as {
      finished_at: string | null;
      exit_code: number | null;
      stdout: string;
      stderr: string;
      stdout_total_bytes: number;
      stderr_total_bytes: number;
      duration_ms: number | null;
      finished_at_ms: number | null;
    };
    expect(row.finished_at).not.toBeNull();
    expect(row.finished_at_ms).toBeGreaterThan(0);
    expect(row.duration_ms).toBeGreaterThanOrEqual(0);
    expect(row.exit_code).toBe(0);
    expect(row.stdout).toContain("Step 1/3");
    expect(row.stdout).toContain("Step 2/3");
    expect(row.stderr).toContain("deprecated flag");
    expect(row.stdout_total_bytes).toBe(
      "Step 1/3 : FROM node:20\nStep 2/3 : RUN apt-get install\n".length,
    );
    expect(row.stderr_total_bytes).toBe("warning: deprecated flag\n".length);
  });

  test("stored stdout is capped at TAIL_CAP_BYTES, totals capture the full size", () => {
    const run = new BuildRun(projectId);
    const big = "x".repeat(TAIL_CAP_BYTES * 3);
    run.appendStdout(big);
    run.finalize(1);

    const row = db.query("SELECT * FROM runs WHERE id = ?").get(run.id) as {
      stdout: string;
      stdout_total_bytes: number;
    };
    // Stored is the tail; total is the truth. The exact byte length of the
    // stored tail can vary by a few bytes after UTF-8 boundary alignment, so
    // assert "close to cap, never above" rather than equality.
    expect(row.stdout.length).toBeLessThanOrEqual(TAIL_CAP_BYTES);
    expect(row.stdout.length).toBeGreaterThan(TAIL_CAP_BYTES - 10);
    expect(row.stdout_total_bytes).toBe(big.length);
  });

  test("finalize is idempotent — subsequent appends are silent no-ops", () => {
    const run = new BuildRun(projectId);
    run.appendStdout("first\n");
    run.finalize(0);
    const firstFinish = db.query("SELECT finished_at_ms FROM runs WHERE id = ?").get(run.id) as {
      finished_at_ms: number;
    };

    run.appendStdout("after-finalize\n");
    run.finalize(1);

    const row = db.query("SELECT * FROM runs WHERE id = ?").get(run.id) as {
      stdout: string;
      exit_code: number;
      finished_at_ms: number;
    };
    expect(row.stdout).not.toContain("after-finalize");
    expect(row.exit_code).toBe(0);
    expect(row.finished_at_ms).toBe(firstFinish.finished_at_ms);
  });
});

describe("#65 orphan sweep on Moor restart", () => {
  // We can't easily reimport db.ts mid-test (Bun's module cache), so we
  // exercise the sweep SQL directly with the same WHERE clause.
  beforeEach(() => {
    db.query("DELETE FROM runs").run();
    db.query("DELETE FROM crons").run();
    db.query("DELETE FROM projects").run();
  });

  // The sweep SQL is duplicated here from db.ts because Bun's module cache
  // makes re-importing db.ts mid-test impractical. Keep in sync with db.ts.
  const SWEEP_SQL = `
    UPDATE runs
    SET finished_at = datetime('now'),
        finished_at_ms = CAST((strftime('%s', 'now') * 1000) AS INTEGER),
        exit_code = 1,
        stderr = COALESCE(stderr, '') ||
                 CASE WHEN stderr IS NULL OR stderr = '' THEN '' ELSE char(10) END ||
                 '[moor restarted; terminal state unknown]',
        stderr_total_bytes = COALESCE(stderr_total_bytes, 0) +
          length(CAST(
            CASE WHEN stderr IS NULL OR stderr = ''
                 THEN '[moor restarted; terminal state unknown]'
                 ELSE char(10) || '[moor restarted; terminal state unknown]'
            END
          AS BLOB))
    WHERE finished_at IS NULL AND cron_id IS NULL
  `;

  test("in-progress build/manual runs are marked failed with an honest stderr note", () => {
    const projectId = makeProject();
    const inserted = db
      .query(
        `INSERT INTO runs (project_id, cron_id, started_at, stderr_total_bytes)
         VALUES (?, NULL, datetime('now'), 0) RETURNING id`,
      )
      .get(projectId) as { id: number };

    db.exec(SWEEP_SQL);

    const row = db.query("SELECT * FROM runs WHERE id = ?").get(inserted.id) as {
      finished_at: string | null;
      exit_code: number;
      stderr: string;
      stderr_total_bytes: number;
    };
    expect(row.finished_at).not.toBeNull();
    expect(row.exit_code).toBe(1);
    expect(row.stderr).toContain("moor restarted");
    // Total bytes must reflect the appended note — otherwise moor_runs
    // would report stderr=0B for a row whose stderr we just wrote.
    expect(row.stderr_total_bytes).toBe(row.stderr.length);
  });

  test("sweep forces exit_code=1 (does not preserve a partial value mid-run)", () => {
    const projectId = makeProject();
    // Imagine a previous codepath had set exit_code optimistically before
    // crashing. An interrupted row's outcome is unknown — preserve nothing.
    const inserted = db
      .query(
        `INSERT INTO runs (project_id, cron_id, started_at, exit_code)
         VALUES (?, NULL, datetime('now'), 0) RETURNING id`,
      )
      .get(projectId) as { id: number };
    db.exec(SWEEP_SQL);
    const row = db.query("SELECT exit_code FROM runs WHERE id = ?").get(inserted.id) as {
      exit_code: number;
    };
    expect(row.exit_code).toBe(1);
  });

  test("sweep appends a newline separator when prior stderr exists, and totals match", () => {
    const projectId = makeProject();
    const inserted = db
      .query(
        `INSERT INTO runs (project_id, cron_id, started_at, stderr, stderr_total_bytes)
         VALUES (?, NULL, datetime('now'), 'prior stderr', 12) RETURNING id`,
      )
      .get(projectId) as { id: number };
    db.exec(SWEEP_SQL);
    const row = db
      .query("SELECT stderr, stderr_total_bytes FROM runs WHERE id = ?")
      .get(inserted.id) as { stderr: string; stderr_total_bytes: number };
    expect(row.stderr).toBe("prior stderr\n[moor restarted; terminal state unknown]");
    expect(row.stderr_total_bytes).toBe(row.stderr.length);
  });

  test("in-progress cron runs are NOT touched by the build sweep", () => {
    const projectId = makeProject();
    const cron = db
      .query(
        "INSERT INTO crons (project_id, name, schedule, command) VALUES (?, 'c', '* * * * *', 'echo') RETURNING id",
      )
      .get(projectId) as { id: number };
    const cronRun = db
      .query(
        `INSERT INTO runs (project_id, cron_id, started_at)
         VALUES (?, ?, datetime('now')) RETURNING id`,
      )
      .get(projectId, cron.id) as { id: number };

    db.exec(SWEEP_SQL);

    const row = db.query("SELECT finished_at FROM runs WHERE id = ?").get(cronRun.id) as {
      finished_at: string | null;
    };
    expect(row.finished_at).toBeNull();
  });

  test("already-finalized rows are left alone (no double-finalize)", () => {
    const projectId = makeProject();
    const done = db
      .query(
        `INSERT INTO runs (project_id, cron_id, started_at, finished_at, exit_code, stdout)
         VALUES (?, NULL, datetime('now', '-1 hour'), datetime('now', '-30 minutes'), 0, 'all good')
         RETURNING id`,
      )
      .get(projectId) as { id: number };

    db.exec(SWEEP_SQL);

    const row = db.query("SELECT * FROM runs WHERE id = ?").get(done.id) as {
      exit_code: number;
      stdout: string;
      finished_at: string;
    };
    expect(row.exit_code).toBe(0);
    expect(row.stdout).toBe("all good");
    // The original finished_at timestamp must be preserved (no overwrite).
  });
});

describe("#68 BuildRun.cancel lifecycle", () => {
  let projectId: number;

  beforeEach(() => {
    db.query("DELETE FROM runs").run();
    db.query("DELETE FROM projects").run();
    activeBuildRuns.clear();
    projectId = makeProject();
  });

  test("cancel during streaming returns 'cancelled' and finalizes exit_code=130 with stderr note", () => {
    const run = new BuildRun(projectId);
    expect(activeBuildRuns.has(run.id)).toBe(true);
    expect(run.abort.signal.aborted).toBe(false);

    const result = run.cancel();
    expect(result).toBe("cancelled");
    expect(run.abort.signal.aborted).toBe(true);
    expect(activeBuildRuns.has(run.id)).toBe(false); // cleaned up

    const row = db.query("SELECT * FROM runs WHERE id = ?").get(run.id) as {
      finished_at: string | null;
      exit_code: number;
      stderr: string;
    };
    expect(row.finished_at).not.toBeNull();
    expect(row.exit_code).toBe(130);
    expect(row.stderr).toContain("[cancelled by user]");
  });

  test("cancel after markStreamingDone returns 'not_cancellable' — container-start phase is past the abort window", () => {
    const run = new BuildRun(projectId);
    run.appendStdout("build done\n");
    run.markStreamingDone();
    const result = run.cancel();
    expect(result).toBe("not_cancellable");
    // Row stays in-flight; the container-start phase will finalize it later.
    const row = db.query("SELECT finished_at FROM runs WHERE id = ?").get(run.id) as {
      finished_at: string | null;
    };
    expect(row.finished_at).toBeNull();
    // Cleanup so beforeEach assertions in the next test hold.
    run.finalize(0);
  });

  test("cancel after finalize returns 'already_finished'", () => {
    const run = new BuildRun(projectId);
    run.finalize(0);
    expect(run.cancel()).toBe("already_finished");
    // exit_code stays at the original finalize value (0), not 130.
    const row = db.query("SELECT exit_code FROM runs WHERE id = ?").get(run.id) as {
      exit_code: number;
    };
    expect(row.exit_code).toBe(0);
  });

  test("double-cancel is idempotent (second call returns 'already_finished')", () => {
    const run = new BuildRun(projectId);
    expect(run.cancel()).toBe("cancelled");
    expect(run.cancel()).toBe("already_finished");
  });

  test("stray finalize after cancel does not rewrite exit_code (in-memory guard)", () => {
    // Defensive coverage: if the build try/catch fires finalize(0) on the
    // same instance after cancel ran, the in-memory `finalized` guard
    // makes it a no-op. The `WHERE finished_at IS NULL` clause in
    // finalize() is a belt-and-suspenders backstop for cross-instance
    // races and isn't exercised here.
    const run = new BuildRun(projectId);
    run.cancel();
    run.finalize(0);
    const row = db.query("SELECT exit_code FROM runs WHERE id = ?").get(run.id) as {
      exit_code: number;
    };
    expect(row.exit_code).toBe(130);
  });
});

describe("#77 BuildRun.interrupt + interruptActiveBuildRuns", () => {
  let projectId: number;

  beforeEach(() => {
    db.query("DELETE FROM runs").run();
    db.query("DELETE FROM projects").run();
    activeBuildRuns.clear();
    projectId = makeProject();
  });

  test("interrupt writes the caller's reason verbatim and finalizes 130", () => {
    const run = new BuildRun(projectId);
    const result = run.interrupt("[moor shutting down; build/pull aborted]");
    expect(result).toBe("cancelled");

    const row = db.query("SELECT exit_code, stderr FROM runs WHERE id = ?").get(run.id) as {
      exit_code: number;
      stderr: string;
    };
    expect(row.exit_code).toBe(130);
    // Reason written verbatim — no default "cancelled by user" override.
    expect(row.stderr).toContain("[moor shutting down; build/pull aborted]");
    expect(row.stderr).not.toContain("cancelled by user");
  });

  test("interrupt past markStreamingDone → 'not_cancellable' (same gate as cancel)", () => {
    const run = new BuildRun(projectId);
    run.markStreamingDone();
    expect(run.interrupt("[moor shutting down]")).toBe("not_cancellable");
    run.finalize(0);
  });

  test("interrupt after finalize → 'already_finished'", () => {
    const run = new BuildRun(projectId);
    run.finalize(0);
    expect(run.interrupt("[moor shutting down]")).toBe("already_finished");
  });

  test("interruptActiveBuildRuns finalizes every active run and returns project IDs for interrupted ones", () => {
    const a = new BuildRun(projectId);
    const b = new BuildRun(projectId);
    const c = new BuildRun(projectId);
    // c is past streaming — should NOT be counted as interrupted.
    c.markStreamingDone();

    const interrupted = interruptActiveBuildRuns("[moor shutting down; build/pull aborted]");
    // Two runs interrupted (a, b); both belong to the same project so the
    // returned array has the project id twice. Callers can dedupe via Set.
    expect(interrupted).toHaveLength(2);
    expect(interrupted.every((id) => id === projectId)).toBe(true);

    const rowA = db.query("SELECT exit_code, stderr FROM runs WHERE id = ?").get(a.id) as {
      exit_code: number;
      stderr: string;
    };
    expect(rowA.exit_code).toBe(130);
    expect(rowA.stderr).toContain("[moor shutting down; build/pull aborted]");
    const rowB = db.query("SELECT exit_code FROM runs WHERE id = ?").get(b.id) as {
      exit_code: number;
    };
    expect(rowB.exit_code).toBe(130);

    // c is still in flight — no finalize. Clean up before the next test.
    c.finalize(0);
  });

  test("calling interruptActiveBuildRuns twice is a no-op for already-finalized rows", () => {
    const run = new BuildRun(projectId);
    expect(interruptActiveBuildRuns("[shutdown]")).toHaveLength(1);
    expect(interruptActiveBuildRuns("[shutdown again]")).toHaveLength(0);
    // First message wins; second call doesn't re-write.
    const row = db.query("SELECT stderr FROM runs WHERE id = ?").get(run.id) as {
      stderr: string;
    };
    expect(row.stderr).toContain("[shutdown]");
    expect(row.stderr).not.toContain("[shutdown again]");
  });

  test("interruptActiveBuildRuns returns project IDs so the shutdown coordinator can reconcile status", () => {
    // The shutdown coordinator needs to know which projects had their
    // builds interrupted so it can reset projects.status from the
    // actual container state. Otherwise status stays 'building' /
    // 'pulling' across restart until the next 30s reconciler tick.
    const p2 = makeProject("second");
    const a = new BuildRun(projectId);
    const b = new BuildRun(p2);

    const interruptedIds = interruptActiveBuildRuns("[shutdown]");
    expect(interruptedIds.sort()).toEqual([projectId, p2].sort());

    // BuildRun.projectId is the source of truth — verify it's accessible.
    expect(a.projectId).toBe(projectId);
    expect(b.projectId).toBe(p2);
  });
});
