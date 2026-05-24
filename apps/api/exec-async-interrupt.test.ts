// Tests for #82 interruptActiveExecRuns. The kill path is mocked via the
// injectable killer parameter so no real Docker is required. The activeRuns
// map is seeded via the _seedActiveExecRunForTest seam so we don't need a
// real running container.

process.env.MOOR_DB_PATH = ":memory:";

import { beforeEach, describe, expect, test } from "bun:test";

const { default: db } = await import("./db");
const { _hasActiveExecRunForTest, _seedActiveExecRunForTest, interruptActiveExecRuns } =
  await import("./exec-async");

function makeProject(): number {
  const row = db
    .query("INSERT INTO projects (name) VALUES (?) RETURNING id")
    .get(`p-${Date.now()}-${Math.random()}`) as { id: number };
  return row.id;
}

function makeRun(projectId: number): number {
  const row = db
    .query(
      "INSERT INTO exec_runs (project_id, command, state, timeout_ms, started_at_ms) VALUES (?, 'cmd', 'running', 60000, ?) RETURNING id",
    )
    .get(projectId, Date.now()) as { id: number };
  return row.id;
}

function readRow(runId: number) {
  return db
    .query(
      "SELECT state, stderr, killed_pid, error_message, finished_at_ms FROM exec_runs WHERE id = ?",
    )
    .get(runId) as {
    state: string;
    stderr: string | null;
    killed_pid: string | null;
    error_message: string | null;
    finished_at_ms: number | null;
  };
}

describe("#82 interruptActiveExecRuns", () => {
  beforeEach(() => {
    db.query("DELETE FROM exec_runs").run();
    db.query("DELETE FROM projects").run();
  });

  test("returns [] and is a no-op when no active runs", async () => {
    let killCalls = 0;
    const ids = await interruptActiveExecRuns("[reason]", async () => {
      killCalls++;
      return { sentTo: "1", live: 0 };
    });
    expect(ids).toEqual([]);
    expect(killCalls).toBe(0);
  });

  test("clean kill (sentTo set, live=0) → stopped with reason in stderr and killed_pid set", async () => {
    const pid = makeProject();
    const rid = makeRun(pid);
    const abort = _seedActiveExecRunForTest(rid, "exec-abc-123");

    const seen: string[] = [];
    const ids = await interruptActiveExecRuns(
      "[moor shutting down; exec killed]",
      async (execId) => {
        seen.push(execId);
        return { sentTo: "42", live: 0 };
      },
    );

    expect(ids).toEqual([rid]);
    expect(seen).toEqual(["exec-abc-123"]);
    expect(abort.signal.aborted).toBe(true);

    const row = readRow(rid);
    expect(row.state).toBe("stopped");
    expect(row.stderr).toContain("[moor shutting down; exec killed]");
    expect(row.killed_pid).toBe("42");
    expect(row.error_message).toBeNull();
    expect(row.finished_at_ms).not.toBeNull();
    expect(_hasActiveExecRunForTest(rid)).toBe(false);
  });

  test("survivors (sentTo set, live>0) → error with survivor count, NOT stopped", async () => {
    const pid = makeProject();
    const rid = makeRun(pid);
    _seedActiveExecRunForTest(rid, "exec-survivors");

    const ids = await interruptActiveExecRuns("[reason]", async () => ({
      sentTo: "42",
      live: 3,
    }));
    expect(ids).toEqual([rid]);

    const row = readRow(rid);
    expect(row.state).toBe("error");
    expect(row.killed_pid).toBe("42");
    expect(row.error_message).toContain("3 descendant(s) remained");
    expect(row.error_message).toContain("[reason]");
    // The reason marker is still in stderr regardless of terminal state.
    expect(row.stderr).toContain("[reason]");
  });

  test("kill couldn't locate process (sentTo=null) → error, NOT stopped", async () => {
    const pid = makeProject();
    const rid = makeRun(pid);
    _seedActiveExecRunForTest(rid, "exec-no-pid");

    const ids = await interruptActiveExecRuns("[reason]", async () => ({
      sentTo: null,
      live: 0,
    }));
    expect(ids).toEqual([rid]);

    const row = readRow(rid);
    expect(row.state).toBe("error");
    expect(row.killed_pid).toBeNull();
    expect(row.error_message).toContain("could not locate the process");
  });

  test("idempotent — second call on the same run does nothing (row already stopped)", async () => {
    const pid = makeProject();
    const rid = makeRun(pid);
    _seedActiveExecRunForTest(rid, "exec-abc-123");

    const first = await interruptActiveExecRuns("[reason]", async () => ({ sentTo: "1", live: 0 }));
    expect(first).toEqual([rid]);

    // Second call: the active map is empty (first call deleted the entry), so
    // the killer is never called and we return [].
    let killCalls = 0;
    const second = await interruptActiveExecRuns("[reason]", async () => {
      killCalls++;
      return { sentTo: "1", live: 0 };
    });
    expect(second).toEqual([]);
    expect(killCalls).toBe(0);
  });

  test("row finalized between snapshot and our finalize is NOT re-finalized", async () => {
    const pid = makeProject();
    const rid = makeRun(pid);
    _seedActiveExecRunForTest(rid, "exec-abc-123");

    // Simulate the race: natural completion finalizes the row to 'exited'
    // before our finalize runs. tryFinalize's WHERE state='running' guard
    // returns changes=0; interruptActiveExecRuns reports it as not-claimed.
    const ids = await interruptActiveExecRuns("[reason]", async () => {
      // While "kill" is "in flight", another path finalizes the row.
      db.query(
        "UPDATE exec_runs SET state='exited', exit_code=0, finished_at_ms=? WHERE id = ? AND state = 'running'",
      ).run(Date.now(), rid);
      return { sentTo: "1", live: 0 };
    });

    expect(ids).toEqual([]); // we didn't claim it
    const row = readRow(rid);
    expect(row.state).toBe("exited"); // the racing path's value preserved
    expect(row.stderr).toBeFalsy(); // our finalize was a no-op; stderr unchanged
  });

  test("slow killer (hangs past timeout) → error with 'outcome unknown', NOT stopped", async () => {
    const pid = makeProject();
    const rid = makeRun(pid);
    _seedActiveExecRunForTest(rid, "exec-slow");

    const startMs = Date.now();
    const ids = await interruptActiveExecRuns(
      "[reason]",
      // Killer that hangs forever — the per-kill timeout fires and we
      // finalize as error (we can't verify the process died).
      () => new Promise(() => {}),
    );
    const elapsed = Date.now() - startMs;

    expect(ids).toEqual([rid]);
    // Should have waited ~3s (PER_KILL_TIMEOUT_MS, bumped in #88 from 1s
    // so a real kill script's SIGTERM grace + verify can return cleanly).
    // Assert under 4.5s for slow CI slack.
    expect(elapsed).toBeLessThan(4500);
    expect(elapsed).toBeGreaterThanOrEqual(2500);
    const row = readRow(rid);
    expect(row.state).toBe("error");
    expect(row.error_message).toContain("kill outcome unknown");
    expect(row.error_message).toContain("timeout");
    expect(row.error_message).toContain("process may have continued");
  });

  test("multiple active runs are processed in parallel and all finalized (clean kills)", async () => {
    const pid = makeProject();
    const rids = [makeRun(pid), makeRun(pid), makeRun(pid)];
    for (const rid of rids) _seedActiveExecRunForTest(rid, `exec-${rid}`);

    let killCalls = 0;
    const ids = await interruptActiveExecRuns("[reason]", async () => {
      killCalls++;
      // Each kill takes ~50ms; if processed serially total would be ~150ms.
      // allSettled means total is ~50ms.
      await new Promise((r) => setTimeout(r, 50));
      return { sentTo: "1", live: 0 };
    });

    expect(ids.sort((a, b) => a - b)).toEqual(rids.sort((a, b) => a - b));
    expect(killCalls).toBe(3);
    for (const rid of rids) {
      expect(readRow(rid).state).toBe("stopped");
      expect(_hasActiveExecRunForTest(rid)).toBe(false);
    }
  });

  test("kill that throws → error with 'outcome unknown', NOT stopped", async () => {
    const pid = makeProject();
    const rid = makeRun(pid);
    _seedActiveExecRunForTest(rid, "exec-throws");

    const ids = await interruptActiveExecRuns("[reason]", async () => {
      throw new Error("docker exploded");
    });

    expect(ids).toEqual([rid]);
    const row = readRow(rid);
    expect(row.state).toBe("error");
    expect(row.error_message).toContain("kill outcome unknown");
    expect(row.error_message).toContain("docker exploded");
  });

  test("active entry with empty execId → error with 'exec had not started', never calls killer", async () => {
    const pid = makeProject();
    const rid = makeRun(pid);
    const abort = _seedActiveExecRunForTest(rid, ""); // exec hadn't started yet

    let killCalls = 0;
    const ids = await interruptActiveExecRuns("[reason]", async () => {
      killCalls++;
      return { sentTo: "1", live: 0 };
    });

    expect(ids).toEqual([rid]);
    expect(killCalls).toBe(0);
    expect(abort.signal.aborted).toBe(true);
    const row = readRow(rid);
    expect(row.state).toBe("error");
    expect(row.error_message).toContain("exec had not started");
  });

  test("mixed kill outcomes across runs → each row reflects its own truth", async () => {
    const pid = makeProject();
    const cleanRid = makeRun(pid);
    const survivorsRid = makeRun(pid);
    const throwsRid = makeRun(pid);
    _seedActiveExecRunForTest(cleanRid, "exec-clean");
    _seedActiveExecRunForTest(survivorsRid, "exec-survivors");
    _seedActiveExecRunForTest(throwsRid, "exec-throws");

    const ids = await interruptActiveExecRuns("[reason]", async (execId) => {
      if (execId === "exec-clean") return { sentTo: "10", live: 0 };
      if (execId === "exec-survivors") return { sentTo: "20", live: 2 };
      throw new Error("daemon down");
    });

    expect(ids.sort((a, b) => a - b)).toEqual(
      [cleanRid, survivorsRid, throwsRid].sort((a, b) => a - b),
    );
    expect(readRow(cleanRid).state).toBe("stopped");
    expect(readRow(survivorsRid).state).toBe("error");
    expect(readRow(throwsRid).state).toBe("error");
  });
});
