// #90: SQLite-safe DB snapshots so moor_update_status can honestly report
// `safe_to_update: YES`. Uses VACUUM INTO (atomic at the SQLite layer) so a
// hot WAL DB can be snapshotted without races. Plain `cp` of the live DB
// would copy mid-checkpoint state and produce a corrupt-looking file.
//
// Conventions:
// - Backups live next to the main DB in the same directory. Cross-host
//   destinations and pre-update auto-backup are deliberately out of scope
//   for #90 — the transient updater in #80 will layer those on top of
//   this module. Filename is `moor.db.backup-<epoch-ms>` so ordering is
//   trivial and collisions impossible.
// - Retention is N most recent; older snapshots are pruned each cycle.
//   N defaults to DEFAULT_KEEP_BACKUPS (7).
// - Scheduler is off by default, opt-in via MOOR_DB_BACKUP_INTERVAL_HOURS
//   (same env pattern as MOOR_CLEANUP_DANGLING_INTERVAL_HOURS, #59).
// - moor_db_backup MCP tool triggers an immediate snapshot for operators
//   who want to backup right before a manual update.

import { readdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import db from "./db";

export const BACKUP_FILE_PREFIX = "moor.db.backup-";
export const DEFAULT_KEEP_BACKUPS = 7;

// Mirror cleanup-scheduler bounds: setInterval clamps delays above
// ~24.8 days to 1ms, and intervals shorter than 1 minute would hammer
// disk for no operational benefit.
const MIN_INTERVAL_MS = 60_000;
const MAX_INTERVAL_MS = 2_147_483_647;
const MIN_HOURS = MIN_INTERVAL_MS / 3_600_000;
const MAX_HOURS = MAX_INTERVAL_MS / 3_600_000;

/** Pure: filename for a snapshot at the given epoch-ms. */
export function backupFilename(epochMs: number): string {
  return `${BACKUP_FILE_PREFIX}${epochMs}`;
}

/** Pure: true if the basename looks like one of our snapshots. */
export function isBackupFile(name: string): boolean {
  return name.startsWith(BACKUP_FILE_PREFIX);
}

/** Resolve the directory backups live in. Throws on `:memory:` since
 *  there's no filesystem to write to in that mode; tests pass an
 *  explicit dir. */
export function defaultBackupDir(): string {
  const dbPath = process.env.MOOR_DB_PATH ?? join(import.meta.dir, "..", "..", "data", "moor.db");
  if (dbPath === ":memory:") {
    throw new Error("Cannot determine backup directory: MOOR_DB_PATH is ':memory:'");
  }
  return dirname(dbPath);
}

export type BackupEntry = { path: string; mtimeMs: number; sizeBytes: number };

/** List backups in `dir` newest first. Missing dir / non-dir / read
 *  failures return []. */
export function listBackups(dir: string): BackupEntry[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const entries: BackupEntry[] = [];
  for (const name of names) {
    if (!isBackupFile(name)) continue;
    const p = join(dir, name);
    try {
      const s = statSync(p);
      if (!s.isFile()) continue;
      entries.push({ path: p, mtimeMs: s.mtimeMs, sizeBytes: s.size });
    } catch {
      // ignore — file may have been removed between readdir and stat
    }
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return entries;
}

/** Keep only the `keep` most recent backups; delete the rest. Returns
 *  the paths actually removed. */
export function pruneBackups(dir: string, keep: number): string[] {
  if (keep < 0) throw new Error("keep must be >= 0");
  const list = listBackups(dir);
  if (list.length <= keep) return [];
  const removed: string[] = [];
  for (const entry of list.slice(keep)) {
    try {
      unlinkSync(entry.path);
      removed.push(entry.path);
    } catch (e) {
      console.warn(
        `[db-backup] failed to prune ${entry.path}:`,
        e instanceof Error ? e.message : e,
      );
    }
  }
  return removed;
}

export type BackupResult = { path: string; sizeBytes: number; durationMs: number };

/** Take a snapshot of the live DB into `dir`. Uses VACUUM INTO which
 *  is atomic at the SQLite layer (a single transaction is reflected
 *  in the snapshot; WAL state is checkpointed in). The filename
 *  embeds Date.now() so two backups can't collide and ordering is
 *  monotonic.
 *
 *  Throws if the target file already exists (Date.now() collision is
 *  impossible in practice) or if SQLite refuses the VACUUM. The caller
 *  decides whether to log and continue (scheduler) or surface (route). */
export function runBackup(opts: { dir: string; keep?: number }): BackupResult {
  const start = Date.now();
  const filename = backupFilename(start);
  const targetPath = join(opts.dir, filename);
  // VACUUM INTO accepts a quoted string literal; escape any embedded
  // single quotes by doubling them (SQL standard). The path comes from
  // server-controlled dir + a Date.now() suffix, but defense-in-depth.
  const escaped = targetPath.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escaped}'`);
  const sizeBytes = statSync(targetPath).size;
  if (opts.keep !== undefined) pruneBackups(opts.dir, opts.keep);
  return { path: targetPath, sizeBytes, durationMs: Date.now() - start };
}

/** Read-only freshness info for moor_update_status. Returns the
 *  documented null shape when no backup exists or the directory can't
 *  be read — same contract as the v1 stub. */
export function getLatestBackupInfo(dir: string = trySafeBackupDir()): {
  last_backup_at: string | null;
  age_seconds: number | null;
  location: string | null;
} {
  if (dir === "") return { last_backup_at: null, age_seconds: null, location: null };
  const list = listBackups(dir);
  if (list.length === 0) return { last_backup_at: null, age_seconds: null, location: null };
  const latest = list[0];
  return {
    last_backup_at: new Date(latest.mtimeMs).toISOString(),
    age_seconds: Math.floor((Date.now() - latest.mtimeMs) / 1000),
    location: latest.path,
  };
}

// In-memory DB mode (tests) doesn't have a backup dir. Swallow the
// throw and return "" so getLatestBackupInfo can degrade to "no backups"
// instead of crashing the route.
function trySafeBackupDir(): string {
  try {
    return defaultBackupDir();
  } catch {
    return "";
  }
}

/** Parse MOOR_DB_BACKUP_INTERVAL_HOURS. Same shape as
 *  cleanup-scheduler's parseIntervalHours: returns null for unset,
 *  empty, non-numeric, zero, negative, below 1 minute, or above the
 *  setInterval ms cap. */
export function parseIntervalHours(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n * 3_600_000;
  if (ms < MIN_INTERVAL_MS || ms > MAX_INTERVAL_MS) return null;
  return n;
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let cycleRunning = false;

/** One scheduled backup pass. Safe to call directly. Never throws —
 *  a backup failure must not crash moor. */
export async function runScheduledBackup(keep: number = DEFAULT_KEEP_BACKUPS): Promise<void> {
  if (cycleRunning) {
    console.log("[db-backup] previous cycle still running; skipping this tick");
    return;
  }
  cycleRunning = true;
  try {
    const dir = defaultBackupDir();
    const result = runBackup({ dir, keep });
    console.log(
      `[db-backup] wrote ${result.path} (${result.sizeBytes}B in ${result.durationMs}ms)`,
    );
  } catch (e) {
    console.error("[db-backup] cycle failed:", e instanceof Error ? e.message : e);
  } finally {
    cycleRunning = false;
  }
}

export function startBackupScheduler(): void {
  const raw = process.env.MOOR_DB_BACKUP_INTERVAL_HOURS;
  if (!raw) return;
  const hours = parseIntervalHours(raw);
  if (hours === null) {
    // Loud rejection: silently leaving the scheduler off makes
    // "I configured backups but nothing happens" hard to diagnose.
    console.warn(
      `[db-backup] ignored MOOR_DB_BACKUP_INTERVAL_HOURS=${raw}: ` +
        `must be a positive number between ${MIN_HOURS} and ${MAX_HOURS} hours`,
    );
    return;
  }
  const intervalMs = hours * 3_600_000;
  console.log(
    `[db-backup] enabled: snapshot every ${hours}h, keeping ${DEFAULT_KEEP_BACKUPS} most recent`,
  );
  intervalHandle = setInterval(() => {
    void runScheduledBackup();
  }, intervalMs);
}

export function stopBackupScheduler(): void {
  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

/** Test-only: lets a test simulate "previous cycle still running"
 *  without actually running one. */
export function _setBackupCycleRunningForTest(value: boolean): void {
  cycleRunning = value;
}
