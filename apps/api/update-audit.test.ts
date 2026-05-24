// Tests for #80 PR #1 update_audit lifecycle + grace-window sweep.
// In-memory SQLite + Date.now-derived assertions; no Docker, no mocks.

process.env.MOOR_DB_PATH = ":memory:";

import { beforeEach, describe, expect, test } from "bun:test";

const { default: db } = await import("./db");
const {
  STALE_IN_PROGRESS_MS,
  finalizeAudit,
  hasInProgressAudit,
  insertAuditInProgress,
  listAudit,
  setBackupPath,
  sweepStaleInProgress,
} = await import("./update-audit");

function reset() {
  db.query("DELETE FROM update_audit").run();
}

describe("#80 PR #1 insertAuditInProgress", () => {
  beforeEach(reset);

  test("inserts a row in_progress with started_at_ms set, nullable fields null", () => {
    const before = Date.now();
    const id = insertAuditInProgress({
      from_digest: "sha256:old",
      to_digest: "sha256:new",
      prev_image_id: "sha256:img",
    });
    const after = Date.now();
    expect(id).toBeGreaterThan(0);
    const row = db.query("SELECT * FROM update_audit WHERE id = ?").get(id) as {
      state: string;
      started_at_ms: number;
      finished_at_ms: number | null;
      duration_ms: number | null;
      backup_path: string | null;
      from_digest: string | null;
      to_digest: string | null;
      prev_image_id: string | null;
    };
    expect(row.state).toBe("in_progress");
    expect(row.started_at_ms).toBeGreaterThanOrEqual(before);
    expect(row.started_at_ms).toBeLessThanOrEqual(after);
    expect(row.finished_at_ms).toBeNull();
    expect(row.duration_ms).toBeNull();
    expect(row.backup_path).toBeNull();
    expect(row.from_digest).toBe("sha256:old");
    expect(row.to_digest).toBe("sha256:new");
    expect(row.prev_image_id).toBe("sha256:img");
  });

  test("from_digest/to_digest/prev_image_id may be null (preflight failed early)", () => {
    const id = insertAuditInProgress({
      from_digest: null,
      to_digest: null,
      prev_image_id: null,
    });
    const row = db
      .query("SELECT from_digest, to_digest FROM update_audit WHERE id = ?")
      .get(id) as {
      from_digest: string | null;
      to_digest: string | null;
    };
    expect(row.from_digest).toBeNull();
    expect(row.to_digest).toBeNull();
  });
});

describe("#80 PR #1 setBackupPath", () => {
  beforeEach(reset);

  test("fills backup_path without transitioning state", () => {
    const id = insertAuditInProgress({ from_digest: null, to_digest: null, prev_image_id: null });
    setBackupPath(id, "/app/data/moor.db.backup-12345");
    const row = db.query("SELECT state, backup_path FROM update_audit WHERE id = ?").get(id) as {
      state: string;
      backup_path: string;
    };
    expect(row.state).toBe("in_progress");
    expect(row.backup_path).toBe("/app/data/moor.db.backup-12345");
  });
});

describe("#80 PR #1 finalizeAudit", () => {
  beforeEach(reset);

  test("transitions in_progress → success, sets finished_at_ms and duration_ms", () => {
    const id = insertAuditInProgress({ from_digest: null, to_digest: null, prev_image_id: null });
    const won = finalizeAudit(id, "success");
    expect(won).toBe(true);
    const row = db
      .query("SELECT state, finished_at_ms, duration_ms FROM update_audit WHERE id = ?")
      .get(id) as { state: string; finished_at_ms: number; duration_ms: number };
    expect(row.state).toBe("success");
    expect(row.finished_at_ms).not.toBeNull();
    expect(row.duration_ms).toBeGreaterThanOrEqual(0);
  });

  test("rolled_back state with rollback_error", () => {
    const id = insertAuditInProgress({ from_digest: null, to_digest: null, prev_image_id: null });
    finalizeAudit(id, "rolled_back", { rollback_error: null, error_log: "health check failed" });
    const row = db.query("SELECT state, error_log FROM update_audit WHERE id = ?").get(id) as {
      state: string;
      error_log: string;
    };
    expect(row.state).toBe("rolled_back");
    expect(row.error_log).toBe("health check failed");
  });

  test("rollback_failed state with both error_log and rollback_error", () => {
    const id = insertAuditInProgress({ from_digest: null, to_digest: null, prev_image_id: null });
    finalizeAudit(id, "rollback_failed", {
      error_log: "new image health check failed",
      rollback_error: "tag command failed: docker daemon error",
    });
    const row = db
      .query("SELECT state, error_log, rollback_error FROM update_audit WHERE id = ?")
      .get(id) as { state: string; error_log: string; rollback_error: string };
    expect(row.state).toBe("rollback_failed");
    expect(row.error_log).toContain("health check failed");
    expect(row.rollback_error).toContain("tag command failed");
  });

  test("idempotent — second finalize on terminal row returns false, row unchanged", () => {
    const id = insertAuditInProgress({ from_digest: null, to_digest: null, prev_image_id: null });
    expect(finalizeAudit(id, "success")).toBe(true);
    expect(finalizeAudit(id, "failed", { error_log: "second attempt" })).toBe(false);
    const row = db.query("SELECT state, error_log FROM update_audit WHERE id = ?").get(id) as {
      state: string;
      error_log: string | null;
    };
    expect(row.state).toBe("success"); // first call's value preserved
    expect(row.error_log).toBeNull();
  });
});

describe("#80 PR #1 hasInProgressAudit / listAudit", () => {
  beforeEach(reset);

  test("hasInProgressAudit returns true iff a row is in_progress", () => {
    expect(hasInProgressAudit()).toBe(false);
    const id = insertAuditInProgress({ from_digest: null, to_digest: null, prev_image_id: null });
    expect(hasInProgressAudit()).toBe(true);
    finalizeAudit(id, "success");
    expect(hasInProgressAudit()).toBe(false);
  });

  test("listAudit returns newest first, respects limit", () => {
    const ids = [
      insertAuditInProgress({ from_digest: "a", to_digest: "a", prev_image_id: null }),
      insertAuditInProgress({ from_digest: "b", to_digest: "b", prev_image_id: null }),
      insertAuditInProgress({ from_digest: "c", to_digest: "c", prev_image_id: null }),
    ];
    const all = listAudit();
    expect(all.length).toBe(3);
    expect(all[0].id).toBe(ids[2]);
    expect(all[2].id).toBe(ids[0]);
    expect(listAudit(2).length).toBe(2);
  });
});

describe("#80 PR #1 sweepStaleInProgress (30-min grace window)", () => {
  beforeEach(reset);

  test("rows within the grace window are NOT swept", () => {
    insertAuditInProgress({ from_digest: null, to_digest: null, prev_image_id: null });
    const swept = sweepStaleInProgress();
    expect(swept).toEqual([]);
    expect(hasInProgressAudit()).toBe(true);
  });

  test("rows older than the grace window ARE swept to 'crashed' with explanatory error_log", () => {
    const id = insertAuditInProgress({
      from_digest: null,
      to_digest: null,
      prev_image_id: null,
    });
    // Backdate the row past the grace window.
    const longAgo = Date.now() - STALE_IN_PROGRESS_MS - 1000;
    db.query("UPDATE update_audit SET started_at_ms = ? WHERE id = ?").run(longAgo, id);

    const swept = sweepStaleInProgress();
    expect(swept).toEqual([id]);

    const row = db
      .query("SELECT state, error_log, duration_ms FROM update_audit WHERE id = ?")
      .get(id) as { state: string; error_log: string; duration_ms: number };
    expect(row.state).toBe("crashed");
    expect(row.error_log).toContain("no respawner marker ingested");
    expect(row.error_log).toContain("30-min grace");
    expect(row.duration_ms).toBeGreaterThanOrEqual(STALE_IN_PROGRESS_MS);
  });

  test("already-terminal rows are NOT re-finalized by sweep", () => {
    const id = insertAuditInProgress({
      from_digest: null,
      to_digest: null,
      prev_image_id: null,
    });
    finalizeAudit(id, "success");
    db.query("UPDATE update_audit SET started_at_ms = ? WHERE id = ?").run(
      Date.now() - STALE_IN_PROGRESS_MS - 1000,
      id,
    );
    const swept = sweepStaleInProgress();
    expect(swept).toEqual([]);
    expect(
      (db.query("SELECT state FROM update_audit WHERE id = ?").get(id) as { state: string }).state,
    ).toBe("success");
  });

  test("mixed: sweeps stale in_progress rows, leaves fresh + terminal rows alone", () => {
    const fresh = insertAuditInProgress({
      from_digest: null,
      to_digest: null,
      prev_image_id: null,
    });
    const stale = insertAuditInProgress({
      from_digest: null,
      to_digest: null,
      prev_image_id: null,
    });
    const done = insertAuditInProgress({ from_digest: null, to_digest: null, prev_image_id: null });
    finalizeAudit(done, "rolled_back");
    db.query("UPDATE update_audit SET started_at_ms = ? WHERE id = ?").run(
      Date.now() - STALE_IN_PROGRESS_MS - 1000,
      stale,
    );

    const swept = sweepStaleInProgress();
    expect(swept).toEqual([stale]);

    const states = (
      db.query("SELECT id, state FROM update_audit ORDER BY id").all() as {
        id: number;
        state: string;
      }[]
    ).reduce<Record<number, string>>((acc, r) => {
      acc[r.id] = r.state;
      return acc;
    }, {});
    expect(states[fresh]).toBe("in_progress");
    expect(states[stale]).toBe("crashed");
    expect(states[done]).toBe("rolled_back");
  });
});
