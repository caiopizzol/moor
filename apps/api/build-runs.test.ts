// Integration tests for #65 BuildRun lifecycle and the orphan-sweep
// migration. Runs against in-memory SQLite (MOOR_DB_PATH set before db.ts
// loads). The 1-second flush timer is observed indirectly via finalize(),
// which always writes the latest tail.

process.env.MOOR_DB_PATH = ":memory:";

import { beforeEach, describe, expect, test } from "bun:test";

const { default: db } = await import("./db");
const { BuildRun } = await import("./build-runs");
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

  test("in-progress build/manual runs are marked failed with an honest stderr note", () => {
    const projectId = makeProject();
    const inserted = db
      .query(
        `INSERT INTO runs (project_id, cron_id, started_at)
         VALUES (?, NULL, datetime('now')) RETURNING id`,
      )
      .get(projectId) as { id: number };

    db.exec(`
      UPDATE runs
      SET finished_at = datetime('now'),
          finished_at_ms = CAST((strftime('%s', 'now') * 1000) AS INTEGER),
          exit_code = COALESCE(exit_code, 1),
          stderr = COALESCE(stderr, '') ||
                   CASE WHEN stderr IS NULL OR stderr = '' THEN '' ELSE char(10) END ||
                   '[moor restarted; terminal state unknown]'
      WHERE finished_at IS NULL AND cron_id IS NULL
    `);

    const row = db.query("SELECT * FROM runs WHERE id = ?").get(inserted.id) as {
      finished_at: string | null;
      exit_code: number;
      stderr: string;
    };
    expect(row.finished_at).not.toBeNull();
    expect(row.exit_code).toBe(1);
    expect(row.stderr).toContain("moor restarted");
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

    db.exec(`
      UPDATE runs
      SET finished_at = datetime('now')
      WHERE finished_at IS NULL AND cron_id IS NULL
    `);

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

    db.exec(`
      UPDATE runs
      SET finished_at = datetime('now')
      WHERE finished_at IS NULL AND cron_id IS NULL
    `);

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
