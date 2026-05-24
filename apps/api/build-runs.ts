// #65: live build observability. INSERT a runs row at deploy-run start,
// stream Docker output into rolling 64 KiB tail buffers, periodically
// UPDATE the row so moor_run_get can tail it mid-build. One row covers
// the whole deploy run: build/pull + port detection + container start.
// Finalize on terminal outcome with total bytes (the truth) so callers
// can render "showing last 64 KiB of N MB" honestly.
//
// #68: BuildRun also holds an AbortController used for the build/pull
// Docker fetch and a `cancellable` flag that flips off once streaming
// completes. cancel() aborts the controller (which makes Docker tear
// down the build/pull) and finalizes the row as exit_code=130 with a
// "[cancelled by user]" stderr note. A module-level activeBuildRuns
// map lets the /api/runs/:id/stop route reach the right handle by run
// id; cron lookup happens first in the route, so this is consulted
// only after stopCronRun returns false (DB cron_id IS NULL is
// ambiguous: deleted crons also have NULL).

import db from "./db";
import { TailBuffer } from "./output-cap";

const FLUSH_INTERVAL_MS = 1000;
const ENC = new TextEncoder();

/** Outcome strings returned by cancel() and the /stop route so the MCP
 *  layer can format honestly without re-deriving from exit codes. */
export type CancelResult = "cancelled" | "already_finished" | "not_cancellable" | "not_active";

export class BuildRun {
  readonly id: number;
  readonly abort = new AbortController();
  private readonly stdout = new TailBuffer();
  private readonly stderr = new TailBuffer();
  private dirty = false;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private finalized = false;
  private cancellable = true;
  private readonly startedAtMs: number;

  constructor(projectId: number) {
    this.startedAtMs = Date.now();
    const row = db
      .query(
        `INSERT INTO runs (project_id, cron_id, started_at, started_at_ms,
                           stdout, stderr, stdout_total_bytes, stderr_total_bytes)
         VALUES (?, NULL, datetime('now'), ?, '', '', 0, 0)
         RETURNING id`,
      )
      .get(projectId, this.startedAtMs) as { id: number };
    this.id = row.id;
    activeBuildRuns.set(this.id, this);

    // Periodic flush — single UPDATE every FLUSH_INTERVAL_MS if dirty.
    // Cheaper than flushing per-line on verbose builds, and bounded SQLite
    // write rate. finalize() clears the timer.
    this.flushTimer = setInterval(() => this.flushIfDirty(), FLUSH_INTERVAL_MS);
  }

  /** Append a line (or any text chunk) to stdout. UTF-8 bytes via the
   *  shared TailBuffer; tail length is bounded, total bytes is preserved. */
  appendStdout(text: string): void {
    if (this.finalized) return;
    this.stdout.appendBytes(ENC.encode(text));
    this.dirty = true;
  }

  appendStderr(text: string): void {
    if (this.finalized) return;
    this.stderr.appendBytes(ENC.encode(text));
    this.dirty = true;
  }

  /** Called by handleRun/handleBuild after the build/pull stream has
   *  drained. Past this point AbortController.abort() can't stop
   *  anything meaningful (container start uses different endpoints), so
   *  cancel() should report not_cancellable instead of finalizing 130
   *  while the container may still come up. */
  markStreamingDone(): void {
    this.cancellable = false;
  }

  private flushIfDirty(): void {
    if (!this.dirty || this.finalized) return;
    db.query(
      `UPDATE runs SET stdout = ?, stderr = ?,
                       stdout_total_bytes = ?, stderr_total_bytes = ?
       WHERE id = ?`,
    ).run(
      this.stdout.tail,
      this.stderr.tail,
      this.stdout.totalBytes,
      this.stderr.totalBytes,
      this.id,
    );
    this.dirty = false;
  }

  /** Mark this run terminal. Idempotent — subsequent appends are no-ops.
   *  exitCode = 0 for full success (build + container started), non-zero
   *  for any phase failure. The final UPDATE captures the post-last-flush
   *  output too, so no append is lost between the last tick and finalize.
   *
   *  WHERE finished_at IS NULL scopes the terminal write so a finalize
   *  losing a race with cancel() becomes a no-op rather than rewriting
   *  the row. */
  finalize(exitCode: number): void {
    if (this.finalized) return;
    this.finalized = true;
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    activeBuildRuns.delete(this.id);
    const finishedAtMs = Date.now();
    db.query(
      `UPDATE runs SET stdout = ?, stderr = ?,
                       stdout_total_bytes = ?, stderr_total_bytes = ?,
                       exit_code = ?,
                       finished_at = datetime('now'),
                       finished_at_ms = ?,
                       duration_ms = ?
       WHERE id = ? AND finished_at IS NULL`,
    ).run(
      this.stdout.tail,
      this.stderr.tail,
      this.stdout.totalBytes,
      this.stderr.totalBytes,
      exitCode,
      finishedAtMs,
      finishedAtMs - this.startedAtMs,
      this.id,
    );
  }

  /** Trigger build/pull cancellation. Returns:
   *  - "already_finished" if finalize() already ran
   *  - "not_cancellable" if streaming has completed (container start phase)
   *  - "cancelled" after aborting the controller and finalizing exit 130
   *
   *  Doesn't return "not_active" — that's the route's responsibility when
   *  the registry doesn't have an entry. */
  cancel(): CancelResult {
    return this.interrupt("[cancelled by user]");
  }

  /** #77: shared abort path used by both operator-initiated cancel and
   *  shutdown-coordinator interrupt. Reason is written to stderr verbatim
   *  (no trailing newline — added here) so callers can use a context-
   *  appropriate message instead of always seeing "[cancelled by user]"
   *  for shutdowns/restarts/crashes. */
  interrupt(reason: string): CancelResult {
    if (this.finalized) return "already_finished";
    if (!this.cancellable) return "not_cancellable";
    this.appendStderr(`${reason}\n`);
    this.abort.abort();
    // 130 is the conventional SIGINT exit code; deriveRunStatus in MCP
    // treats anything non-zero as failed, which is correct for now.
    this.finalize(130);
    return "cancelled";
  }
}

/** #77: interrupt every in-flight build/pull during shutdown. Returns
 *  the count actually interrupted (some may already be finalized or past
 *  the cancellable window). The reason string is written to each row's
 *  stderr — typical use is "[moor shutting down; build/pull aborted]"
 *  so a post-restart inspector sees a truthful terminal state instead
 *  of the orphan-sweep's generic "Moor restarted; terminal state
 *  unknown". */
export function interruptActiveBuildRuns(reason: string): number {
  let count = 0;
  for (const run of activeBuildRuns.values()) {
    if (run.interrupt(reason) === "cancelled") count++;
  }
  return count;
}

/** Active in-flight BuildRun handles by run id. Populated in the
 *  constructor, removed in finalize(). The /api/runs/:id/stop route
 *  uses this map as the source of truth for "is this run active and
 *  cancellable" — the DB row alone can't say (cron_id IS NULL is
 *  ambiguous after ON DELETE SET NULL, and a row may be in flight but
 *  past the cancellable window). After a Moor restart the map is empty;
 *  the #65 orphan sweep in db.ts marks those rows failed with the
 *  "Moor restarted; terminal state unknown" stderr line. */
export const activeBuildRuns: Map<number, BuildRun> = new Map();
