// #131 subsystem 6: retention for observability history. ON by default (unlike
// the opt-in cleanup scheduler): the sampler writes a row per project per
// minute, so unbounded growth would be a silent disk leak — exactly what a
// tool that ships disk cleanup must not do. Operator can tune the window via
// MOOR_HISTORY_RETENTION_DAYS; invalid/unset falls back to the default.
//
// Prunes samples and events on the same window. Events are low-volume (only on
// change) so 30d of them is tiny, but keeping a single window keeps the config
// surface small.

import db from "./db";

const DEFAULT_RETENTION_DAYS = 30;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000; // hourly
const DAY_MS = 24 * 60 * 60 * 1000;

let intervalHandle: ReturnType<typeof setInterval> | null = null;

/** Resolve the retention window in days. Unset/empty/non-positive/non-numeric
 *  all fall back to the 30-day default rather than disabling retention — we
 *  never want the leak-prevention to silently turn off. */
export function resolveRetentionDays(raw: string | undefined): number {
  if (!raw) return DEFAULT_RETENTION_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_RETENTION_DAYS;
  return Math.floor(n);
}

/** Delete samples and events older than cutoffMs. Returns rows removed. */
export function pruneHistory(cutoffMs: number): { samples: number; events: number } {
  const s = db.query("DELETE FROM project_resource_samples WHERE sampled_at_ms < ?").run(cutoffMs);
  const e = db.query("DELETE FROM project_events WHERE occurred_at_ms < ?").run(cutoffMs);
  return { samples: s.changes, events: e.changes };
}

export function runRetention(retentionDays: number, nowMs: number = Date.now()): void {
  const cutoff = nowMs - retentionDays * DAY_MS;
  const { samples, events } = pruneHistory(cutoff);
  if (samples > 0 || events > 0) {
    console.log(
      `[history-retention] pruned ${samples} sample(s), ${events} event(s) older than ${retentionDays}d`,
    );
  }
}

export function startHistoryRetention(): void {
  const days = resolveRetentionDays(process.env.MOOR_HISTORY_RETENTION_DAYS);
  console.log(`[history-retention] enabled: prune samples/events older than ${days}d, hourly`);
  // Run once at boot so a long downtime doesn't leave a backlog until the
  // first hourly tick.
  runRetention(days);
  intervalHandle = setInterval(() => runRetention(days), PRUNE_INTERVAL_MS);
}

export function stopHistoryRetention(): void {
  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
