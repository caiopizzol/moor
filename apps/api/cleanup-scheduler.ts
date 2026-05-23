// #59 v1: scheduled dangling-image cleanup. Off by default — operator
// opts in via MOOR_CLEANUP_DANGLING_INTERVAL_HOURS=N. Reuses planCleanup
// and executeCleanup from #54 v1 so the eligibility filter, re-validation
// at execute time, and cleanup_audit row are identical to a manual call.
//
// Concurrency: one moor process holds a single in-memory `cycleRunning`
// flag. If a cycle is still running when the next tick fires, skip it
// rather than overlap. moor is a single-instance control plane (no
// horizontal replicas), so an in-process flag is sufficient — no need
// for a DB lock.

import { type ExecuteCandidate, executeCleanup, planCleanup } from "./cleanup";

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let cycleRunning = false;

// setInterval clamps any delay > 2_147_483_647ms (~24.8 days) to 1ms with
// a TimeoutOverflowWarning — a "monthly-ish" value (720 hours) would
// silently turn into a tight loop. Cap before passing to setInterval.
// Lower bound is 1 minute: faster than that is misconfiguration, never
// useful for cleanup of a host you control.
const MIN_INTERVAL_MS = 60_000;
const MAX_INTERVAL_MS = 2_147_483_647;
const MIN_HOURS = MIN_INTERVAL_MS / 3_600_000;
const MAX_HOURS = MAX_INTERVAL_MS / 3_600_000;

/** Parse the env var value into hours. Returns null when the var is
 *  unset, empty, non-numeric, zero, negative, below ~1 minute, or above
 *  the setInterval ms cap (~596 hours / 24.8 days). The scheduler stays
 *  off in any of those cases. */
export function parseIntervalHours(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n * 3_600_000;
  if (ms < MIN_INTERVAL_MS || ms > MAX_INTERVAL_MS) return null;
  return n;
}

/** One scheduled cleanup pass. Safe to call directly (tests do). Logs
 *  start/end with audit_id, candidate count, reclaimed bytes, and
 *  per-candidate error count. Never throws — a cleanup failure must
 *  not crash the moor process. */
export async function runScheduledCleanup(): Promise<void> {
  if (cycleRunning) {
    console.log("[cleanup-scheduler] previous cycle still running; skipping this tick");
    return;
  }
  cycleRunning = true;
  try {
    const plan = await planCleanup(["dangling_image"]);
    if (plan.candidates.length === 0) {
      console.log("[cleanup-scheduler] nothing to clean");
      return;
    }
    const candidates: ExecuteCandidate[] = plan.candidates.flatMap((c) =>
      c.category === "dangling_image" ? [{ category: "dangling_image", id: c.id }] : [],
    );
    const result = await executeCleanup(candidates);
    const failures = result.results.filter((r) => r.error !== null).length;
    console.log(
      `[cleanup-scheduler] audit_id=${result.audit_id} candidates=${candidates.length} reclaimed=${result.total_reclaimed_bytes}B errors=${failures}`,
    );
  } catch (e) {
    console.error("[cleanup-scheduler] cycle failed:", e instanceof Error ? e.message : e);
  } finally {
    cycleRunning = false;
  }
}

export function startCleanupScheduler(): void {
  const raw = process.env.MOOR_CLEANUP_DANGLING_INTERVAL_HOURS;
  if (!raw) return;
  const hours = parseIntervalHours(raw);
  if (hours === null) {
    // Operator set a value but it was out of range — say so loudly rather
    // than silently leaving the scheduler off. Quiet rejection makes
    // "I configured cleanup but nothing happens" hard to diagnose.
    console.warn(
      `[cleanup-scheduler] ignored MOOR_CLEANUP_DANGLING_INTERVAL_HOURS=${raw}: ` +
        `must be a positive number between ${MIN_HOURS} and ${MAX_HOURS} hours`,
    );
    return;
  }
  const intervalMs = hours * 3_600_000;
  console.log(`[cleanup-scheduler] enabled: dangling image cleanup every ${hours}h`);
  intervalHandle = setInterval(() => {
    void runScheduledCleanup();
  }, intervalMs);
}

/** Exposed for tests and graceful shutdown. */
export function stopCleanupScheduler(): void {
  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

/** Test-only: lets a test simulate "previous cycle still running" without
 *  actually running one. Not exported beyond the test file. */
export function _setCycleRunningForTest(value: boolean): void {
  cycleRunning = value;
}
