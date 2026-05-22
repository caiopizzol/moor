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
});
