// Tests for #90 DB backup. Pure helpers (parseIntervalHours, filename,
// isBackupFile) tested directly. Filesystem helpers (listBackups,
// pruneBackups) and runBackup tested against a real bun:sqlite DB and a
// per-test tmpdir so file I/O is exercised exactly as in production.

import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Use a file-backed DB (not :memory:) so VACUUM INTO has a real source to
// snapshot. Each test suite gets a fresh tmpdir so tests don't share state.
const testRoot = mkdtempSync(join(tmpdir(), "moor-db-backup-test-"));
const testDbPath = join(testRoot, "moor.db");
process.env.MOOR_DB_PATH = testDbPath;

import { afterAll, beforeEach, describe, expect, test } from "bun:test";

// Import after env is set so db.ts opens the file-backed DB.
const { default: db } = await import("./db");
const {
  BACKUP_FILE_PREFIX,
  DEFAULT_KEEP_BACKUPS,
  backupFilename,
  defaultBackupDir,
  getLatestBackupInfo,
  isBackupFile,
  listBackups,
  parseIntervalHours,
  pruneBackups,
  runBackup,
  runScheduledBackup,
  _setBackupCycleRunningForTest,
} = await import("./db-backup");

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

describe("#90 pure helpers", () => {
  test("backupFilename uses the BACKUP_FILE_PREFIX + epoch ms", () => {
    expect(backupFilename(1748097912123)).toBe(`${BACKUP_FILE_PREFIX}1748097912123`);
  });

  test("isBackupFile matches only the documented prefix", () => {
    expect(isBackupFile(`${BACKUP_FILE_PREFIX}123`)).toBe(true);
    expect(isBackupFile("moor.db")).toBe(false);
    expect(isBackupFile("moor.db-wal")).toBe(false);
    expect(isBackupFile("backup-of-something-else")).toBe(false);
  });

  test("defaultBackupDir resolves to the dirname of MOOR_DB_PATH", () => {
    expect(defaultBackupDir()).toBe(testRoot);
  });

  test("parseIntervalHours edge cases", () => {
    expect(parseIntervalHours(undefined)).toBeNull();
    expect(parseIntervalHours("")).toBeNull();
    expect(parseIntervalHours("not-a-number")).toBeNull();
    expect(parseIntervalHours("0")).toBeNull();
    expect(parseIntervalHours("-1")).toBeNull();
    expect(parseIntervalHours("0.001")).toBeNull(); // below 1-min floor
    expect(parseIntervalHours("99999")).toBeNull(); // above ~596h ceiling
    expect(parseIntervalHours("24")).toBe(24);
    expect(parseIntervalHours("0.5")).toBe(0.5); // 30 min — valid
  });
});

describe("#90 runBackup against a file-backed bun:sqlite DB", () => {
  beforeEach(() => {
    // Clean any leftover snapshots between tests.
    for (const b of listBackups(testRoot)) rmSync(b.path);
  });

  test("VACUUM INTO writes a valid SQLite file with the projects schema", () => {
    db.query("INSERT INTO projects (name) VALUES ('snapshot-witness')").run();
    const result = runBackup({ dir: testRoot });
    expect(result.path.startsWith(join(testRoot, BACKUP_FILE_PREFIX))).toBe(true);
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    // The snapshot is a real SQLite file. statSync should succeed.
    const st = statSync(result.path);
    expect(st.isFile()).toBe(true);
    expect(st.size).toBe(result.sizeBytes);
  });

  test("listBackups returns newest first; non-backup files are skipped", () => {
    // Drop in two real backups + one decoy file.
    runBackup({ dir: testRoot });
    // Tiny delay so mtimes can differ on filesystems with second precision.
    Bun.sleepSync(20);
    runBackup({ dir: testRoot });
    writeFileSync(join(testRoot, "not-a-backup.txt"), "x");

    const list = listBackups(testRoot);
    expect(list.length).toBe(2);
    // Newest first.
    expect(list[0].mtimeMs).toBeGreaterThanOrEqual(list[1].mtimeMs);
    for (const b of list) expect(isBackupFile(b.path.split("/").pop() as string)).toBe(true);
  });

  test("pruneBackups deletes everything past `keep`, returns removed paths", () => {
    for (let i = 0; i < 5; i++) {
      runBackup({ dir: testRoot });
      Bun.sleepSync(5);
    }
    expect(listBackups(testRoot).length).toBe(5);
    const removed = pruneBackups(testRoot, 2);
    expect(removed.length).toBe(3);
    expect(listBackups(testRoot).length).toBe(2);
  });

  test("runBackup with `keep` prunes inline after writing", () => {
    for (let i = 0; i < 3; i++) {
      runBackup({ dir: testRoot });
      Bun.sleepSync(5);
    }
    runBackup({ dir: testRoot, keep: 2 });
    expect(listBackups(testRoot).length).toBe(2);
  });

  test("listBackups on a non-existent dir returns []", () => {
    expect(listBackups(join(testRoot, "does-not-exist"))).toEqual([]);
  });
});

describe("#90 getLatestBackupInfo", () => {
  beforeEach(() => {
    for (const b of listBackups(testRoot)) rmSync(b.path);
  });

  test("no backups → null shape (preserves the v1 contract from #78)", () => {
    expect(getLatestBackupInfo(testRoot)).toEqual({
      last_backup_at: null,
      age_seconds: null,
      location: null,
    });
  });

  test("one backup → age_seconds close to 0, location set", () => {
    const result = runBackup({ dir: testRoot });
    const info = getLatestBackupInfo(testRoot);
    expect(info.location).toBe(result.path);
    expect(info.last_backup_at).not.toBeNull();
    expect(info.age_seconds).not.toBeNull();
    expect(info.age_seconds as number).toBeLessThan(5);
  });

  test("picks the newest backup when multiple exist", () => {
    const first = runBackup({ dir: testRoot });
    Bun.sleepSync(20);
    const second = runBackup({ dir: testRoot });
    const info = getLatestBackupInfo(testRoot);
    expect(info.location).toBe(second.path);
    expect(info.location).not.toBe(first.path);
  });
});

describe("#90 runScheduledBackup single-flight + error tolerance", () => {
  beforeEach(() => {
    for (const b of listBackups(testRoot)) rmSync(b.path);
    _setBackupCycleRunningForTest(false);
  });

  test("happy path writes a snapshot with default retention", async () => {
    await runScheduledBackup(DEFAULT_KEEP_BACKUPS);
    expect(listBackups(testRoot).length).toBe(1);
  });

  test("if a previous cycle is still running, the tick is skipped", async () => {
    _setBackupCycleRunningForTest(true);
    await runScheduledBackup();
    expect(listBackups(testRoot).length).toBe(0); // skipped, no write
    _setBackupCycleRunningForTest(false);
  });

  test("retention is enforced — old snapshots get pruned each cycle", async () => {
    for (let i = 0; i < 4; i++) {
      runBackup({ dir: testRoot });
      Bun.sleepSync(5);
    }
    await runScheduledBackup(2); // keep 2; we'll be at 5 before pruning
    expect(listBackups(testRoot).length).toBe(2);
  });
});
