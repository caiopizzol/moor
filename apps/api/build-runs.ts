// #65: live build observability. INSERT a runs row at deploy-run start,
// stream Docker output into rolling 64 KiB tail buffers, periodically
// UPDATE the row so moor_run_get can tail it mid-build. One row covers
// the whole deploy run: build/pull + port detection + container start.
// Finalize on terminal outcome with total bytes (the truth) so callers
// can render "showing last 64 KiB of N MB" honestly.

import db from "./db";
import { TailBuffer } from "./output-cap";

const FLUSH_INTERVAL_MS = 1000;
const ENC = new TextEncoder();

export class BuildRun {
  readonly id: number;
  private readonly stdout = new TailBuffer();
  private readonly stderr = new TailBuffer();
  private dirty = false;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private finalized = false;
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
   *  output too, so no append is lost between the last tick and finalize. */
  finalize(exitCode: number): void {
    if (this.finalized) return;
    this.finalized = true;
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    const finishedAtMs = Date.now();
    db.query(
      `UPDATE runs SET stdout = ?, stderr = ?,
                       stdout_total_bytes = ?, stderr_total_bytes = ?,
                       exit_code = ?,
                       finished_at = datetime('now'),
                       finished_at_ms = ?,
                       duration_ms = ?
       WHERE id = ?`,
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
}
