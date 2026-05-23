// Tests for the race-safety invariant of #34 Phase B terminal-state
// transitions. The full orchestration in exec-async.ts can't be unit-tested
// without mocking Docker, but the underlying invariant — that
// `UPDATE exec_runs SET ... WHERE id=? AND state='running'` makes the first
// finalize call win and ignores subsequent ones — IS testable in isolation
// against the actual schema. If this invariant breaks, the orchestration
// breaks too.

process.env.MOOR_DB_PATH = ":memory:";

import { beforeEach, describe, expect, test } from "bun:test";

const { default: db } = await import("./db");

function makeProject(): number {
  const row = db
    .query("INSERT INTO projects (name) VALUES (?) RETURNING id")
    .get(`p-${Date.now()}-${Math.random()}`) as { id: number };
  return row.id;
}

function makeRun(projectId: number): number {
  const row = db
    .query(
      "INSERT INTO exec_runs (project_id, command, timeout_ms) VALUES (?, 'cmd', 60000) RETURNING id",
    )
    .get(projectId) as { id: number };
  return row.id;
}

describe("exec_runs race-safe terminal transition", () => {
  beforeEach(() => {
    db.query("DELETE FROM exec_runs").run();
    db.query("DELETE FROM projects").run();
  });

  test("first UPDATE WHERE state='running' wins; second one does nothing", () => {
    const pid = makeProject();
    const rid = makeRun(pid);

    const first = db
      .query(
        "UPDATE exec_runs SET state='exited', exit_code=0, finished_at=datetime('now') WHERE id=? AND state='running'",
      )
      .run(rid);
    expect(first.changes).toBe(1);

    const second = db
      .query(
        "UPDATE exec_runs SET state='stopped', killed_pid='999', finished_at=datetime('now') WHERE id=? AND state='running'",
      )
      .run(rid);
    expect(second.changes).toBe(0);

    const final = db
      .query("SELECT state, exit_code, killed_pid FROM exec_runs WHERE id=?")
      .get(rid) as { state: string; exit_code: number | null; killed_pid: string | null };
    expect(final.state).toBe("exited");
    expect(final.exit_code).toBe(0);
    expect(final.killed_pid).toBeNull();
  });

  test("a UPDATE without the state guard would overwrite the terminal state", () => {
    // This documents WHY the guard matters: without it, a late safety-timer
    // callback can stomp on a natural-exit row.
    const pid = makeProject();
    const rid = makeRun(pid);

    db.query("UPDATE exec_runs SET state='exited', exit_code=0 WHERE id=?").run(rid);
    db.query("UPDATE exec_runs SET state='timed_out', killed_pid='999' WHERE id=?").run(rid);

    const final = db.query("SELECT state FROM exec_runs WHERE id=?").get(rid) as { state: string };
    expect(final.state).toBe("timed_out"); // second write won
    // The guarded form prevents this.
  });

  test("orphan sweep marks running rows as error on import (already ran)", () => {
    // The sweep runs once when db.ts is imported. Insert a fake 'running' row
    // and verify the sweep query (run again here to simulate restart) catches it.
    const pid = makeProject();
    const rid = makeRun(pid);
    expect(
      (db.query("SELECT state FROM exec_runs WHERE id=?").get(rid) as { state: string }).state,
    ).toBe("running");

    // Re-run the same SQL the startup sweep runs
    db.query(
      `UPDATE exec_runs
       SET state = 'error',
           error_message = 'process may have continued past moor restart; terminal state unknown',
           finished_at = datetime('now')
       WHERE state = 'running'`,
    ).run();

    const row = db
      .query("SELECT state, error_message, finished_at FROM exec_runs WHERE id=?")
      .get(rid) as { state: string; error_message: string; finished_at: string };
    expect(row.state).toBe("error");
    expect(row.error_message).toContain("moor restart");
    expect(row.finished_at).not.toBeNull();
  });

  test("runs scoped to project_id; deleting a project cascades to its runs", () => {
    const pid = makeProject();
    const rid = makeRun(pid);
    db.query("DELETE FROM projects WHERE id=?").run(pid);
    const row = db.query("SELECT id FROM exec_runs WHERE id=?").get(rid);
    expect(row).toBeNull();
  });

  // #45: schema and migration for ms-precision timestamps
  test("exec_runs has started_at_ms and finished_at_ms columns", () => {
    const cols = db.query("PRAGMA table_info(exec_runs)").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain("started_at_ms");
    expect(names).toContain("finished_at_ms");
  });

  test("migration backfill populates started_at_ms from started_at text", () => {
    const pid = makeProject();
    // Simulate a pre-#45 row: started_at_ms NULL, started_at = a known second.
    db.query(
      "INSERT INTO exec_runs (project_id, command, timeout_ms, started_at, started_at_ms) VALUES (?, 'old', 60000, '2025-01-01 12:34:56', NULL)",
    ).run(pid);
    // Re-run the same backfill query the startup migration runs
    db.query(
      "UPDATE exec_runs SET started_at_ms = CAST(strftime('%s', started_at) AS INTEGER) * 1000 WHERE started_at_ms IS NULL AND started_at IS NOT NULL",
    ).run();
    const row = db.query("SELECT started_at_ms FROM exec_runs WHERE command = 'old'").get() as {
      started_at_ms: number;
    };
    expect(row.started_at_ms).toBe(Date.UTC(2025, 0, 1, 12, 34, 56));
  });

  test("backfill leaves _ms NULL when text timestamp is also NULL", () => {
    const pid = makeProject();
    db.query(
      "INSERT INTO exec_runs (project_id, command, timeout_ms, finished_at, finished_at_ms) VALUES (?, 'no-finish', 60000, NULL, NULL)",
    ).run(pid);
    db.query(
      "UPDATE exec_runs SET finished_at_ms = CAST(strftime('%s', finished_at) AS INTEGER) * 1000 WHERE finished_at_ms IS NULL AND finished_at IS NOT NULL",
    ).run();
    const row = db
      .query("SELECT finished_at_ms FROM exec_runs WHERE command = 'no-finish'")
      .get() as { finished_at_ms: number | null };
    expect(row.finished_at_ms).toBeNull();
  });

  test("duration from _ms columns is millisecond-accurate even when text timestamps collide", () => {
    const pid = makeProject();
    const startMs = 1_700_000_000_500;
    const finishMs = 1_700_000_000_750; // 250 ms after start, same wall-clock second
    db.query(
      `INSERT INTO exec_runs
       (project_id, command, state, exit_code, timeout_ms,
        started_at, started_at_ms, finished_at, finished_at_ms)
       VALUES (?, 'fast', 'exited', 0, 60000,
               '2023-11-14 22:13:20', ?, '2023-11-14 22:13:20', ?)`,
    ).run(pid, startMs, finishMs);
    const row = db
      .query(
        "SELECT started_at_ms, finished_at_ms, started_at, finished_at FROM exec_runs WHERE command = 'fast'",
      )
      .get() as {
      started_at_ms: number;
      finished_at_ms: number;
      started_at: string;
      finished_at: string;
    };
    // _ms preserves the 250 ms duration that text columns lose to second-rounding
    expect(row.finished_at_ms - row.started_at_ms).toBe(250);
    expect(
      new Date(`${row.finished_at}Z`).getTime() - new Date(`${row.started_at}Z`).getTime(),
    ).toBe(0);
  });
});
