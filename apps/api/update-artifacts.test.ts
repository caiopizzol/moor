// Tests for #98 update-artifacts. In-memory SQLite for the audit
// table (the db module is a singleton across the whole bun test
// process — colocating a file-backed DB inside our tmpdir would
// race with any other test file doing the same and bring the
// process down when the first afterAll rmSync's the path). The
// artifact/marker files do need real filesystem, so they live in
// a per-test tmpdir that's safe to delete.

process.env.MOOR_DB_PATH = ":memory:";

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testRoot = mkdtempSync(join(tmpdir(), "moor-update-artifacts-test-"));

import { afterAll, beforeEach, describe, expect, test } from "bun:test";

const { default: db } = await import("./db");
const { finalizeAudit, insertAuditInProgress } = await import("./update-audit");
const { artifactFilename, parseArtifactFilename, sweepAllArtifacts, sweepArtifactsForAudit } =
  await import("./update-artifacts");

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

function newDataDir(): string {
  return mkdtempSync(join(testRoot, "data-"));
}

function touch(dir: string, name: string, body = "x"): string {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
}

function listDataFiles(dir: string): string[] {
  // testRoot only holds artifact/marker test files now — DB is in-memory.
  return readdirSync(dir);
}

function reset() {
  db.query("DELETE FROM update_audit").run();
}

describe("#98 parseArtifactFilename", () => {
  test("recognizes all three documented patterns", () => {
    expect(parseArtifactFilename(".update-context-7.json")).toEqual({
      kind: "context",
      audit_id: 7,
    });
    expect(parseArtifactFilename(".update-override-7.yml")).toEqual({
      kind: "override",
      audit_id: 7,
    });
    expect(parseArtifactFilename(".update-rollback-7.yml")).toEqual({
      kind: "rollback",
      audit_id: 7,
    });
  });

  test("strict id parsing: no leading zeros, no scientific notation", () => {
    expect(parseArtifactFilename(".update-context-001.json")).toBeNull();
    expect(parseArtifactFilename(".update-context-1e3.json")).toBeNull();
    expect(parseArtifactFilename(".update-context-0.json")).toBeNull();
    expect(parseArtifactFilename(".update-context-.json")).toBeNull();
  });

  test("rejects wrong suffix (avoid touching files outside the contract)", () => {
    // context uses .json; override/rollback use .yml — swapping suffixes
    // must NOT match either spec.
    expect(parseArtifactFilename(".update-context-7.yml")).toBeNull();
    expect(parseArtifactFilename(".update-override-7.json")).toBeNull();
  });

  test("ignores unrelated dotfiles / non-prefix names", () => {
    expect(parseArtifactFilename(".update-result-7.json")).toBeNull(); // marker, owned by update-marker.ts
    expect(parseArtifactFilename("moor.db.backup-12345")).toBeNull();
    expect(parseArtifactFilename(".env")).toBeNull();
  });
});

describe("#98 artifactFilename round-trip", () => {
  test("artifactFilename + parseArtifactFilename are bijective", () => {
    for (const kind of ["context", "override", "rollback"] as const) {
      const id = 42;
      const name = artifactFilename(kind, id);
      const parsed = parseArtifactFilename(name);
      expect(parsed).toEqual({ kind, audit_id: id });
    }
  });
});

describe("#98 sweepArtifactsForAudit (targeted, post-finalize)", () => {
  test("isTerminal=true deletes all three files for the matching audit_id", () => {
    const dir = newDataDir();
    touch(dir, ".update-context-5.json");
    touch(dir, ".update-override-5.yml");
    touch(dir, ".update-rollback-5.yml");
    const deleted = sweepArtifactsForAudit(dir, 5, true);
    expect(deleted.length).toBe(3);
    expect(listDataFiles(dir)).toEqual([]);
  });

  test("isTerminal=false is a no-op (in_progress audit must keep its files)", () => {
    const dir = newDataDir();
    touch(dir, ".update-context-5.json");
    touch(dir, ".update-override-5.yml");
    const deleted = sweepArtifactsForAudit(dir, 5, false);
    expect(deleted).toEqual([]);
    expect(listDataFiles(dir).length).toBe(2);
  });

  test("missing files are silently ignored (partial sets are fine)", () => {
    const dir = newDataDir();
    touch(dir, ".update-context-5.json");
    // override + rollback never written (success path without rollback)
    const deleted = sweepArtifactsForAudit(dir, 5, true);
    expect(deleted.length).toBe(1);
  });

  test("only touches the specified audit_id, not siblings", () => {
    const dir = newDataDir();
    touch(dir, ".update-context-5.json");
    touch(dir, ".update-context-6.json"); // sibling, must survive
    sweepArtifactsForAudit(dir, 5, true);
    expect(listDataFiles(dir)).toEqual([".update-context-6.json"]);
  });
});

describe("#98 sweepAllArtifacts (boot scan)", () => {
  beforeEach(reset);

  test("terminal audit → all three files deleted", () => {
    const dir = newDataDir();
    const id = insertAuditInProgress({ from_digest: null, to_digest: null, prev_image_id: null });
    finalizeAudit(id, "success");
    touch(dir, `.update-context-${id}.json`);
    touch(dir, `.update-override-${id}.yml`);
    touch(dir, `.update-rollback-${id}.yml`);

    const r = sweepAllArtifacts(dir);
    expect(r.deleted.length).toBe(3);
    expect(r.skipped_in_progress).toEqual([]);
    expect(r.skipped_unknown_audit).toEqual([]);
    expect(listDataFiles(dir)).toEqual([]);
  });

  test("in_progress audit → files kept; counts surface in skipped_in_progress", () => {
    const dir = newDataDir();
    const id = insertAuditInProgress({ from_digest: null, to_digest: null, prev_image_id: null });
    touch(dir, `.update-context-${id}.json`);
    touch(dir, `.update-override-${id}.yml`);

    const r = sweepAllArtifacts(dir);
    expect(r.deleted).toEqual([]);
    expect(r.skipped_in_progress).toEqual([id]);
    expect(r.skipped_unknown_audit).toEqual([]);
    expect(listDataFiles(dir).length).toBe(2);
  });

  test("unknown audit_id → files kept; logged in skipped_unknown_audit (manual cleanup only)", () => {
    const dir = newDataDir();
    // No insertAuditInProgress for id 999 — operator may have purged DB.
    touch(dir, ".update-context-999.json");
    touch(dir, ".update-override-999.yml");

    const r = sweepAllArtifacts(dir);
    expect(r.deleted).toEqual([]);
    expect(r.skipped_in_progress).toEqual([]);
    expect(r.skipped_unknown_audit).toEqual([999]);
    expect(listDataFiles(dir).length).toBe(2);
  });

  test("mixed: terminal + in_progress + unknown in one dir; each handled correctly", () => {
    const dir = newDataDir();
    const termId = insertAuditInProgress({
      from_digest: null,
      to_digest: null,
      prev_image_id: null,
    });
    finalizeAudit(termId, "rolled_back", { error_log: "x" });
    const inProgId = insertAuditInProgress({
      from_digest: null,
      to_digest: null,
      prev_image_id: null,
    });

    touch(dir, `.update-context-${termId}.json`);
    touch(dir, `.update-override-${termId}.yml`);
    touch(dir, `.update-rollback-${termId}.yml`);
    touch(dir, `.update-context-${inProgId}.json`);
    touch(dir, `.update-override-${inProgId}.yml`);
    touch(dir, ".update-context-12345.json"); // unknown

    const r = sweepAllArtifacts(dir);
    expect(r.deleted.length).toBe(3); // termId's three files
    expect(r.skipped_in_progress).toEqual([inProgId]);
    expect(r.skipped_unknown_audit).toEqual([12345]);

    const remaining = listDataFiles(dir).sort();
    expect(remaining).toEqual(
      [
        `.update-context-${inProgId}.json`,
        `.update-override-${inProgId}.yml`,
        ".update-context-12345.json",
      ].sort(),
    );
  });

  test("ignores non-artifact files (markers, backups, operator files)", () => {
    const dir = newDataDir();
    touch(dir, ".update-result-1.json"); // marker — owned by update-marker.ts
    touch(dir, "moor.db.backup-12345"); // db-backup
    touch(dir, "README.md"); // operator file
    touch(dir, ".env");

    const r = sweepAllArtifacts(dir);
    expect(r.deleted).toEqual([]);
    expect(r.skipped_in_progress).toEqual([]);
    expect(r.skipped_unknown_audit).toEqual([]);
    expect(listDataFiles(dir).length).toBe(4);
  });

  test("missing dir → empty result (no throw)", () => {
    const r = sweepAllArtifacts(join(testRoot, "does-not-exist"));
    expect(r.deleted).toEqual([]);
  });

  test("each terminal state is treated as terminal", () => {
    for (const state of [
      "success",
      "failed",
      "rolled_back",
      "rollback_failed",
      "crashed",
    ] as const) {
      reset();
      const dir = newDataDir();
      const id = insertAuditInProgress({
        from_digest: null,
        to_digest: null,
        prev_image_id: null,
      });
      if (state === "crashed") {
        // crashed isn't writable via finalizeAudit; emulate the sweep result.
        db.query("UPDATE update_audit SET state = 'crashed' WHERE id = ?").run(id);
      } else {
        finalizeAudit(id, state);
      }
      touch(dir, `.update-context-${id}.json`);
      const r = sweepAllArtifacts(dir);
      expect(r.deleted.length).toBe(1);
    }
  });
});

describe("#98 integration: finalize → next sweep removes the row's artifacts", () => {
  beforeEach(reset);

  test("inserting + finalizing a row makes its artifacts eligible on next sweep", () => {
    const dir = newDataDir();
    const id = insertAuditInProgress({ from_digest: null, to_digest: null, prev_image_id: null });
    touch(dir, `.update-context-${id}.json`);
    touch(dir, `.update-override-${id}.yml`);

    // Before finalize: in_progress, files preserved.
    let r = sweepAllArtifacts(dir);
    expect(r.deleted).toEqual([]);
    expect(r.skipped_in_progress).toEqual([id]);

    // Finalize, then sweep again: files now eligible.
    finalizeAudit(id, "success");
    r = sweepAllArtifacts(dir);
    expect(r.deleted.length).toBe(2);
    expect(listDataFiles(dir)).toEqual([]);
  });
});
