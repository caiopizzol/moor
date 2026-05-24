// Tests for #80 PR #2 marker-file ingestion. Synthetic marker JSON in a
// per-test tmpdir; in-memory SQLite for the audit table. No Docker.

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testRoot = mkdtempSync(join(tmpdir(), "moor-update-marker-test-"));
process.env.MOOR_DB_PATH = join(testRoot, "moor.db");

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";

const { default: db } = await import("./db");
const { disableDrain, enableDrain, getDrainState } = await import("./drain");
const { insertAuditInProgress, sweepStaleInProgress, STALE_IN_PROGRESS_MS } = await import(
  "./update-audit"
);
const {
  MARKER_PREFIX,
  MARKER_SUFFIX,
  _setPollRunningForTest,
  ingestAllMarkers,
  ingestMarker,
  listMarkerFiles,
  parseMarkerFilename,
  parseMarkerPayload,
  runScheduledIngest,
} = await import("./update-marker");

const markerDir = testRoot;

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

function writeMarker(auditId: number | string, payload: unknown): string {
  const path = join(markerDir, `${MARKER_PREFIX}${auditId}${MARKER_SUFFIX}`);
  writeFileSync(path, typeof payload === "string" ? payload : JSON.stringify(payload));
  return path;
}

function clearMarkerDir() {
  for (const name of readdirSync(markerDir)) {
    if (name === "moor.db" || name.startsWith("moor.db-")) continue;
    try {
      rmSync(join(markerDir, name));
    } catch {
      // ignore
    }
  }
}

function resetAll() {
  db.query("DELETE FROM update_audit").run();
  clearMarkerDir();
  disableDrain();
  _setPollRunningForTest(false);
}

describe("#80 PR #2 parseMarkerFilename", () => {
  test("happy path", () => {
    expect(parseMarkerFilename(".update-result-7.json")).toBe(7);
    expect(parseMarkerFilename(".update-result-12345.json")).toBe(12345);
  });
  test("missing prefix/suffix → null", () => {
    expect(parseMarkerFilename("update-result-7.json")).toBeNull();
    expect(parseMarkerFilename(".update-result-7")).toBeNull();
    expect(parseMarkerFilename(".other-7.json")).toBeNull();
  });
  test("non-integer or non-positive → null", () => {
    expect(parseMarkerFilename(".update-result-abc.json")).toBeNull();
    expect(parseMarkerFilename(".update-result-7.5.json")).toBeNull();
    expect(parseMarkerFilename(".update-result-0.json")).toBeNull();
    expect(parseMarkerFilename(".update-result--3.json")).toBeNull();
  });
  test("empty middle → null", () => {
    expect(parseMarkerFilename(".update-result-.json")).toBeNull();
  });
});

describe("#80 PR #2 parseMarkerPayload", () => {
  test("happy path with success state", () => {
    const r = parseMarkerPayload({ audit_id: 1, state: "success" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.audit_id).toBe(1);
    expect(r.payload.state).toBe("success");
  });
  test("rejects in_progress and crashed (those are moor's decisions, not respawner's)", () => {
    expect(parseMarkerPayload({ audit_id: 1, state: "in_progress" }).ok).toBe(false);
    expect(parseMarkerPayload({ audit_id: 1, state: "crashed" }).ok).toBe(false);
  });
  test("accepts all four marker states", () => {
    for (const state of ["success", "rolled_back", "rollback_failed", "failed"]) {
      expect(parseMarkerPayload({ audit_id: 1, state }).ok).toBe(true);
    }
  });
  test("error_log / rollback_error must be string|null when present", () => {
    expect(parseMarkerPayload({ audit_id: 1, state: "success", error_log: 5 }).ok).toBe(false);
    expect(parseMarkerPayload({ audit_id: 1, state: "success", rollback_error: {} }).ok).toBe(
      false,
    );
    expect(parseMarkerPayload({ audit_id: 1, state: "success", error_log: null }).ok).toBe(true);
    expect(parseMarkerPayload({ audit_id: 1, state: "success", rollback_error: "x" }).ok).toBe(
      true,
    );
  });
  test("non-object / array / null → reject", () => {
    expect(parseMarkerPayload(null).ok).toBe(false);
    expect(parseMarkerPayload("string").ok).toBe(false);
    expect(parseMarkerPayload([]).ok).toBe(false);
  });
  test("audit_id must be a positive integer", () => {
    expect(parseMarkerPayload({ audit_id: 0, state: "success" }).ok).toBe(false);
    expect(parseMarkerPayload({ audit_id: -1, state: "success" }).ok).toBe(false);
    expect(parseMarkerPayload({ audit_id: 1.5, state: "success" }).ok).toBe(false);
    expect(parseMarkerPayload({ audit_id: "1", state: "success" }).ok).toBe(false);
  });
});

describe("#80 PR #2 ingestMarker — happy paths", () => {
  beforeEach(resetAll);
  afterEach(resetAll);

  test("success: transitions in_progress → success, deletes marker, clears drain", () => {
    const auditId = insertAuditInProgress({
      from_digest: "sha:old",
      to_digest: "sha:new",
      prev_image_id: "img-prev",
    });
    enableDrain({ reason: "test-update", ttl_minutes: 30 });

    const path = writeMarker(auditId, { audit_id: auditId, state: "success" });
    const result = ingestMarker(path);

    expect(result.kind).toBe("ingested");
    if (result.kind !== "ingested") return;
    expect(result.state).toBe("success");
    expect(result.drain_cleared).toBe(true);

    const row = db.query("SELECT state FROM update_audit WHERE id = ?").get(auditId) as {
      state: string;
    };
    expect(row.state).toBe("success");
    expect(getDrainState().enabled).toBe(false);
    expect(listMarkerFiles(markerDir).length).toBe(0);
  });

  test("rolled_back: transitions in_progress → rolled_back, deletes marker, does NOT clear drain", () => {
    const auditId = insertAuditInProgress({
      from_digest: "sha:old",
      to_digest: "sha:new",
      prev_image_id: "img-prev",
    });
    enableDrain({ reason: "test-update", ttl_minutes: 30 });

    const path = writeMarker(auditId, {
      audit_id: auditId,
      state: "rolled_back",
      error_log: "health check failed on new image",
    });
    const result = ingestMarker(path);

    expect(result.kind).toBe("ingested");
    if (result.kind !== "ingested") return;
    expect(result.state).toBe("rolled_back");
    expect(result.drain_cleared).toBe(false);

    const row = db.query("SELECT state, error_log FROM update_audit WHERE id = ?").get(auditId) as {
      state: string;
      error_log: string;
    };
    expect(row.state).toBe("rolled_back");
    expect(row.error_log).toContain("health check failed");
    expect(getDrainState().enabled).toBe(true);
    expect(listMarkerFiles(markerDir).length).toBe(0);
  });

  test("rollback_failed: both error_log and rollback_error propagated; drain NOT cleared", () => {
    const auditId = insertAuditInProgress({
      from_digest: "sha:old",
      to_digest: "sha:new",
      prev_image_id: "img-prev",
    });
    enableDrain({ reason: "x", ttl_minutes: 30 });

    const path = writeMarker(auditId, {
      audit_id: auditId,
      state: "rollback_failed",
      error_log: "health check failed",
      rollback_error: "docker tag failed",
    });
    const result = ingestMarker(path);
    expect(result.kind).toBe("ingested");
    if (result.kind !== "ingested") return;
    expect(result.drain_cleared).toBe(false);

    const row = db
      .query("SELECT state, error_log, rollback_error FROM update_audit WHERE id = ?")
      .get(auditId) as { state: string; error_log: string; rollback_error: string };
    expect(row.state).toBe("rollback_failed");
    expect(row.error_log).toBe("health check failed");
    expect(row.rollback_error).toBe("docker tag failed");
  });

  test("failed: transitions in_progress → failed, drain NOT cleared", () => {
    const auditId = insertAuditInProgress({
      from_digest: null,
      to_digest: null,
      prev_image_id: null,
    });
    enableDrain({ reason: "x", ttl_minutes: 30 });

    const path = writeMarker(auditId, {
      audit_id: auditId,
      state: "failed",
      error_log: "pull failed",
    });
    const result = ingestMarker(path);
    expect(result.kind).toBe("ingested");
    if (result.kind !== "ingested") return;
    expect(result.drain_cleared).toBe(false);
    expect(getDrainState().enabled).toBe(true);
  });
});

describe("#80 PR #2 ingestMarker — error paths", () => {
  beforeEach(resetAll);
  afterEach(resetAll);

  test("unknown audit_id → quarantined, no transition", () => {
    const path = writeMarker(9999, { audit_id: 9999, state: "success" });
    const result = ingestMarker(path);
    expect(result.kind).toBe("unknown_audit");
    if (result.kind !== "unknown_audit") return;
    expect(result.audit_id).toBe(9999);
    // Quarantined file should exist; original should not.
    const names = readdirSync(markerDir);
    expect(names.some((n) => n.includes(".bad."))).toBe(true);
    expect(listMarkerFiles(markerDir).length).toBe(0);
  });

  test("filename/JSON audit_id mismatch → quarantined", () => {
    const auditId = insertAuditInProgress({
      from_digest: null,
      to_digest: null,
      prev_image_id: null,
    });
    // Filename says auditId, JSON says some other id.
    const path = writeMarker(auditId, { audit_id: auditId + 100, state: "success" });
    const result = ingestMarker(path);
    expect(result.kind).toBe("id_mismatch");
    if (result.kind !== "id_mismatch") return;
    expect(result.filename_id).toBe(auditId);
    expect(result.payload_id).toBe(auditId + 100);
    // Row stays in_progress.
    expect(
      (db.query("SELECT state FROM update_audit WHERE id = ?").get(auditId) as { state: string })
        .state,
    ).toBe("in_progress");
  });

  test("malformed JSON → quarantined", () => {
    const auditId = insertAuditInProgress({
      from_digest: null,
      to_digest: null,
      prev_image_id: null,
    });
    const path = writeMarker(auditId, "{not json at all");
    const result = ingestMarker(path);
    expect(result.kind).toBe("malformed");
    if (result.kind !== "malformed") return;
    expect(result.reason).not.toBe("");
  });

  test("invalid state in payload → malformed/quarantined", () => {
    const auditId = insertAuditInProgress({
      from_digest: null,
      to_digest: null,
      prev_image_id: null,
    });
    const path = writeMarker(auditId, { audit_id: auditId, state: "in_progress" });
    const result = ingestMarker(path);
    expect(result.kind).toBe("malformed");
  });
});

describe("#80 PR #2 ingestMarker — duplicate/stale handling", () => {
  beforeEach(resetAll);
  afterEach(resetAll);

  test("duplicate marker for already-terminal row → deleted as stale, NOT quarantined", () => {
    const auditId = insertAuditInProgress({
      from_digest: null,
      to_digest: null,
      prev_image_id: null,
    });
    // First ingest wins.
    writeMarker(auditId, { audit_id: auditId, state: "success" });
    expect(ingestMarker(join(markerDir, `${MARKER_PREFIX}${auditId}${MARKER_SUFFIX}`)).kind).toBe(
      "ingested",
    );
    // Now write another marker for the same audit id. Row is terminal.
    const path = writeMarker(auditId, { audit_id: auditId, state: "success" });
    const result = ingestMarker(path);
    expect(result.kind).toBe("stale_or_duplicate");
    // Should be cleanly deleted, NOT quarantined.
    const names = readdirSync(markerDir);
    expect(names.some((n) => n.includes(".bad."))).toBe(false);
    expect(listMarkerFiles(markerDir).length).toBe(0);
  });
});

describe("#80 PR #2 ingestAllMarkers + runScheduledIngest", () => {
  beforeEach(resetAll);
  afterEach(resetAll);

  test("ingestAllMarkers processes every matching file and ignores other files", () => {
    const idA = insertAuditInProgress({
      from_digest: null,
      to_digest: null,
      prev_image_id: null,
    });
    const idB = insertAuditInProgress({
      from_digest: null,
      to_digest: null,
      prev_image_id: null,
    });
    writeMarker(idA, { audit_id: idA, state: "success" });
    writeMarker(idB, { audit_id: idB, state: "failed", error_log: "x" });
    // Unrelated file in same dir.
    writeFileSync(join(markerDir, "moor.db.backup-12345"), "junk");

    const results = ingestAllMarkers(markerDir);
    expect(results.length).toBe(2);
    expect(results.every((r) => r.kind === "ingested")).toBe(true);
    // Unrelated file untouched.
    expect(readdirSync(markerDir).some((n) => n === "moor.db.backup-12345")).toBe(true);
  });

  test("runScheduledIngest is single-flight — returns [] if previous still running", async () => {
    const auditId = insertAuditInProgress({
      from_digest: null,
      to_digest: null,
      prev_image_id: null,
    });
    writeMarker(auditId, { audit_id: auditId, state: "success" });

    _setPollRunningForTest(true);
    const results = await runScheduledIngest(markerDir);
    expect(results).toEqual([]);
    // Marker should still be there because we skipped the cycle.
    expect(listMarkerFiles(markerDir).length).toBe(1);

    _setPollRunningForTest(false);
    const results2 = await runScheduledIngest(markerDir);
    expect(results2.length).toBe(1);
    expect(results2[0].kind).toBe("ingested");
  });
});

describe("#80 PR #2 boot order: ingest BEFORE sweep", () => {
  beforeEach(resetAll);
  afterEach(resetAll);

  test("a stale-but-valid marker that arrived during downtime wins against the sweep", () => {
    // Simulate: an audit row was inserted >30 min ago and a respawner
    // wrote a 'success' marker during that downtime. If sweep runs first
    // the row becomes 'crashed' and the marker can no longer ingest. The
    // documented boot order in index.ts is ingest → sweep, which this
    // test enforces in code.
    const auditId = insertAuditInProgress({
      from_digest: null,
      to_digest: null,
      prev_image_id: null,
    });
    db.query("UPDATE update_audit SET started_at_ms = ? WHERE id = ?").run(
      Date.now() - STALE_IN_PROGRESS_MS - 1000,
      auditId,
    );
    writeMarker(auditId, { audit_id: auditId, state: "success" });

    // Boot sequence: ingest first.
    ingestAllMarkers(markerDir);
    const sweptIds = sweepStaleInProgress();

    expect(sweptIds).toEqual([]);
    expect(
      (db.query("SELECT state FROM update_audit WHERE id = ?").get(auditId) as { state: string })
        .state,
    ).toBe("success");
  });

  test("wrong order (sweep first) loses the race — codifies why index.ts must ingest first", () => {
    // This test exists to document the failure mode if anyone re-orders
    // the boot steps in index.ts. It must stay.
    const auditId = insertAuditInProgress({
      from_digest: null,
      to_digest: null,
      prev_image_id: null,
    });
    db.query("UPDATE update_audit SET started_at_ms = ? WHERE id = ?").run(
      Date.now() - STALE_IN_PROGRESS_MS - 1000,
      auditId,
    );
    writeMarker(auditId, { audit_id: auditId, state: "success" });

    // Wrong order: sweep first.
    sweepStaleInProgress();
    ingestAllMarkers(markerDir);

    // Row now reads 'crashed' from the sweep; the success marker's
    // finalize is a no-op (WHERE state='in_progress' guard) and the file
    // is deleted as a duplicate. Drain is NOT cleared.
    const row = db.query("SELECT state FROM update_audit WHERE id = ?").get(auditId) as {
      state: string;
    };
    expect(row.state).toBe("crashed");
  });
});
