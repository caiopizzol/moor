// #80 PR #1: update_audit row lifecycle + 30-min grace-window startup sweep.
//
// The audit row is INSERTed BEFORE the backup runs so a backup failure
// (or any failure between INSERT and respawner launch) is captured as
// state='failed'. backup_path is nullable for that reason. Subsequent
// state transitions are written by:
//   - moor itself, when backup or launch fails → 'failed'
//   - the marker-ingest path (PR #2), when respawner writes a result
//     → 'success' / 'rolled_back' / 'rollback_failed'
//   - the startup sweep below, when an in_progress row is older than
//     the grace window → 'crashed'
//
// 'crashed' means the respawner never wrote a marker — either it
// crashed mid-flight, or moor was restarted before the marker
// arrived, or there's no respawner running at all. Operator must
// investigate.

import db from "./db";

// 30 minutes. A respawner that takes longer than this to write its
// marker is genuinely stuck and the operator should know. Shorter
// windows risk racing a slow respawner; longer windows hide a hung
// update for too long.
export const STALE_IN_PROGRESS_MS = 30 * 60_000;

export type UpdateAuditState =
  | "in_progress"
  | "success"
  | "rolled_back"
  | "rollback_failed"
  | "failed"
  | "crashed";

export type UpdateAuditRow = {
  id: number;
  started_at: string;
  started_at_ms: number;
  finished_at: string | null;
  finished_at_ms: number | null;
  duration_ms: number | null;
  state: UpdateAuditState;
  from_digest: string | null;
  to_digest: string | null;
  prev_image_id: string | null;
  backup_path: string | null;
  rollback_error: string | null;
  error_log: string | null;
};

/** Insert a new audit row in state='in_progress'. Returns the row id.
 *  Backup path and finished_at_ms are filled in later — this insert
 *  happens before the backup runs so failures between here and
 *  respawner launch are still captured. */
export function insertAuditInProgress(input: {
  from_digest: string | null;
  to_digest: string | null;
  prev_image_id: string | null;
}): number {
  const nowMs = Date.now();
  const row = db
    .query(
      `INSERT INTO update_audit (started_at_ms, state, from_digest, to_digest, prev_image_id)
       VALUES (?, 'in_progress', ?, ?, ?) RETURNING id`,
    )
    .get(nowMs, input.from_digest, input.to_digest, input.prev_image_id) as { id: number };
  return row.id;
}

/** Update an in-progress row's backup_path once the backup completes
 *  successfully. No state transition — the row stays in_progress
 *  until the respawner reports back. */
export function setBackupPath(auditId: number, backupPath: string): void {
  db.query("UPDATE update_audit SET backup_path = ? WHERE id = ?").run(backupPath, auditId);
}

/** Transition a row to a terminal state. Race-safe via
 *  WHERE state='in_progress' so a marker-ingest race or a sweep race
 *  can't overwrite an already-terminal row. Returns true if this call
 *  won (changes=1). */
export function finalizeAudit(
  auditId: number,
  state: Exclude<UpdateAuditState, "in_progress">,
  fields: { error_log?: string | null; rollback_error?: string | null } = {},
): boolean {
  const nowMs = Date.now();
  const startedAtMs = (
    db.query("SELECT started_at_ms FROM update_audit WHERE id = ?").get(auditId) as {
      started_at_ms: number;
    } | null
  )?.started_at_ms;
  const durationMs = startedAtMs === undefined ? null : nowMs - startedAtMs;
  const result = db
    .query(
      `UPDATE update_audit
       SET state = ?,
           finished_at = datetime('now'),
           finished_at_ms = ?,
           duration_ms = ?,
           error_log = COALESCE(?, error_log),
           rollback_error = COALESCE(?, rollback_error)
       WHERE id = ? AND state = 'in_progress'`,
    )
    .run(
      state,
      nowMs,
      durationMs,
      fields.error_log ?? null,
      fields.rollback_error ?? null,
      auditId,
    );
  return result.changes > 0;
}

/** True iff any in_progress row exists. Used to refuse concurrent
 *  update attempts. */
export function hasInProgressAudit(): boolean {
  const row = db
    .query("SELECT 1 as one FROM update_audit WHERE state = 'in_progress' LIMIT 1")
    .get() as { one: number } | null;
  return row !== null;
}

/** Get the most recent N audit rows, newest first. Secondary sort by
 *  id DESC breaks ties when two inserts land in the same millisecond
 *  (rare but possible in tests). */
export function listAudit(limit = 20): UpdateAuditRow[] {
  return db
    .query("SELECT * FROM update_audit ORDER BY started_at_ms DESC, id DESC LIMIT ?")
    .all(limit) as UpdateAuditRow[];
}

/** Startup-and-periodic sweep. Marks any in_progress row whose
 *  started_at_ms is older than the grace window as 'crashed'. The
 *  grace exists because a respawner is mid-flight at the moment moor
 *  restarts — the sweep must not race the marker-ingest path and
 *  prematurely declare a successful update 'crashed'.
 *
 *  Returns the IDs swept so callers can log. Safe to call repeatedly. */
export function sweepStaleInProgress(nowMs: number = Date.now()): number[] {
  const cutoff = nowMs - STALE_IN_PROGRESS_MS;
  const rows = db
    .query("SELECT id FROM update_audit WHERE state = 'in_progress' AND started_at_ms < ?")
    .all(cutoff) as { id: number }[];
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  db.query(
    `UPDATE update_audit
     SET state = 'crashed',
         finished_at = datetime('now'),
         finished_at_ms = ?,
         duration_ms = ? - started_at_ms,
         error_log = COALESCE(error_log, ?)
     WHERE state = 'in_progress' AND started_at_ms < ?`,
  ).run(
    nowMs,
    nowMs,
    "no respawner marker ingested within 30-min grace window; respawner crashed or never started",
    cutoff,
  );
  return ids;
}
