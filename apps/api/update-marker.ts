// #80 PR #2: respawner-result marker ingestion. The transient respawner
// (PR #3) writes one `.update-result-<audit_id>.json` per attempt into the
// shared /app/data volume; this module ingests them into the matching
// update_audit row, then deletes the file. The poller catches markers that
// arrive after moor finishes booting.
//
// Contract (locked in #80 design review):
// - Filename MUST be exact: `.update-result-<audit_id>.json`. Anything else
//   in /app/data is ignored — moor itself writes other dotfiles there.
// - JSON payload MUST contain the same audit_id. Mismatch → quarantine
//   (rename to `<filename>.bad.<ts>`), don't ingest.
// - Accepted marker states: success | rolled_back | rollback_failed |
//   failed. Markers never carry in_progress or crashed — those are moor's
//   own decisions.
// - finalizeAudit() returning false means the row is already terminal.
//   Delete the marker as stale/duplicate; don't quarantine.
// - Missing audit row for a marker → quarantine so the poller doesn't
//   re-process the same dead file every tick.
// - Drain clears ONLY on `success`. After `rolled_back` moor is back on
//   the previous version and the original update didn't land — drain
//   stays so the operator notices.
// - Boot order (enforced in index.ts): ingest markers BEFORE sweep, so a
//   valid marker that landed during downtime can't lose a race with the
//   grace-window sweep.

import { readdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import db from "./db";
import { disableDrain } from "./drain";
import { finalizeAudit } from "./update-audit";

export const MARKER_PREFIX = ".update-result-";
export const MARKER_SUFFIX = ".json";
export const ACCEPTED_MARKER_STATES = [
  "success",
  "rolled_back",
  "rollback_failed",
  "failed",
] as const;
export type MarkerState = (typeof ACCEPTED_MARKER_STATES)[number];

export type MarkerPayload = {
  audit_id: number;
  state: MarkerState;
  error_log?: string | null;
  rollback_error?: string | null;
};

export type IngestResult =
  | { kind: "ingested"; audit_id: number; state: MarkerState; drain_cleared: boolean }
  | { kind: "stale_or_duplicate"; audit_id: number }
  | { kind: "unknown_audit"; audit_id: number; quarantined: string }
  | { kind: "malformed"; quarantined: string; reason: string }
  | { kind: "id_mismatch"; filename_id: number; payload_id: number; quarantined: string };

/** Pure: extract audit_id from a marker filename. Returns null when the
 *  filename doesn't match the documented pattern. Used both by the poller
 *  filter AND by the id-mismatch check in ingestMarker. */
export function parseMarkerFilename(name: string): number | null {
  if (!name.startsWith(MARKER_PREFIX) || !name.endsWith(MARKER_SUFFIX)) return null;
  const middle = name.slice(MARKER_PREFIX.length, -MARKER_SUFFIX.length);
  if (middle.length === 0) return null;
  const n = Number(middle);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

/** Pure: validate the JSON payload shape. Returns the typed payload on
 *  success or a reason string on failure (for the quarantine log line). */
export function parseMarkerPayload(
  raw: unknown,
): { ok: true; payload: MarkerPayload } | { ok: false; reason: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "payload must be a JSON object" };
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.audit_id !== "number" || !Number.isInteger(obj.audit_id) || obj.audit_id <= 0) {
    return { ok: false, reason: "audit_id must be a positive integer" };
  }
  if (
    typeof obj.state !== "string" ||
    !(ACCEPTED_MARKER_STATES as readonly string[]).includes(obj.state)
  ) {
    return {
      ok: false,
      reason: `state must be one of: ${ACCEPTED_MARKER_STATES.join(" | ")}`,
    };
  }
  const payload: MarkerPayload = {
    audit_id: obj.audit_id,
    state: obj.state as MarkerState,
  };
  if (obj.error_log !== undefined) {
    if (obj.error_log !== null && typeof obj.error_log !== "string") {
      return { ok: false, reason: "error_log must be string or null" };
    }
    payload.error_log = obj.error_log as string | null;
  }
  if (obj.rollback_error !== undefined) {
    if (obj.rollback_error !== null && typeof obj.rollback_error !== "string") {
      return { ok: false, reason: "rollback_error must be string or null" };
    }
    payload.rollback_error = obj.rollback_error as string | null;
  }
  return { ok: true, payload };
}

function quarantine(filePath: string, reason: string): string {
  const bad = `${filePath}.bad.${Date.now()}`;
  try {
    renameSync(filePath, bad);
  } catch (e) {
    // Best-effort. If rename failed (perm, race), unlink to at least
    // stop the poll loop from re-reading.
    try {
      unlinkSync(filePath);
    } catch {
      // give up
    }
    console.warn(
      `[update-marker] quarantine rename failed for ${basename(filePath)}; unlinked instead:`,
      e instanceof Error ? e.message : e,
    );
    return filePath;
  }
  console.warn(`[update-marker] quarantined ${basename(filePath)}: ${reason} → ${basename(bad)}`);
  return bad;
}

/** Ingest a single marker file: read, validate, transition audit row,
 *  delete-or-quarantine. Never throws — returns a discriminated result. */
export function ingestMarker(filePath: string): IngestResult {
  const name = basename(filePath);
  const filenameId = parseMarkerFilename(name);
  if (filenameId === null) {
    return {
      kind: "malformed",
      quarantined: quarantine(filePath, "filename pattern mismatch"),
      reason: "filename pattern mismatch",
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf-8"));
  } catch (e) {
    const reason = e instanceof Error ? e.message : "JSON parse error";
    return { kind: "malformed", quarantined: quarantine(filePath, reason), reason };
  }

  const parsed = parseMarkerPayload(raw);
  if (!parsed.ok) {
    return {
      kind: "malformed",
      quarantined: quarantine(filePath, parsed.reason),
      reason: parsed.reason,
    };
  }

  if (parsed.payload.audit_id !== filenameId) {
    return {
      kind: "id_mismatch",
      filename_id: filenameId,
      payload_id: parsed.payload.audit_id,
      quarantined: quarantine(
        filePath,
        `filename audit_id=${filenameId} != payload audit_id=${parsed.payload.audit_id}`,
      ),
    };
  }

  // Check row existence BEFORE finalize so we can distinguish
  // "already terminal" (legit duplicate; delete cleanly) from
  // "no such audit row" (suspicious; quarantine).
  const existing = db
    .query("SELECT state FROM update_audit WHERE id = ?")
    .get(parsed.payload.audit_id) as { state: string } | null;
  if (!existing) {
    return {
      kind: "unknown_audit",
      audit_id: parsed.payload.audit_id,
      quarantined: quarantine(filePath, `no update_audit row for id=${parsed.payload.audit_id}`),
    };
  }

  const won = finalizeAudit(parsed.payload.audit_id, parsed.payload.state, {
    error_log: parsed.payload.error_log ?? null,
    rollback_error: parsed.payload.rollback_error ?? null,
  });

  if (!won) {
    // Row was already terminal — legitimate duplicate (e.g. respawner
    // retry, or marker re-processed). Delete cleanly; don't quarantine.
    try {
      unlinkSync(filePath);
    } catch (e) {
      console.warn(
        `[update-marker] failed to unlink stale ${basename(filePath)}:`,
        e instanceof Error ? e.message : e,
      );
    }
    return { kind: "stale_or_duplicate", audit_id: parsed.payload.audit_id };
  }

  // Successful transition. Delete the marker.
  try {
    unlinkSync(filePath);
  } catch (e) {
    console.warn(
      `[update-marker] failed to unlink ${basename(filePath)} after ingest:`,
      e instanceof Error ? e.message : e,
    );
  }

  // Drain clears ONLY on `success`. After `rolled_back` we're on the OLD
  // version and the original update didn't land — drain stays so the
  // operator notices the failed attempt. TTL or moor_drain_disable
  // clears it later.
  let drainCleared = false;
  if (parsed.payload.state === "success") {
    try {
      disableDrain();
      drainCleared = true;
      console.log(`[update-marker] success for audit_id=${parsed.payload.audit_id}; cleared drain`);
    } catch (e) {
      console.warn(
        `[update-marker] failed to clear drain after success:`,
        e instanceof Error ? e.message : e,
      );
    }
  }

  return {
    kind: "ingested",
    audit_id: parsed.payload.audit_id,
    state: parsed.payload.state,
    drain_cleared: drainCleared,
  };
}

/** List marker files in `dir` (no ingestion). Used by the poller and
 *  exposed for tests. Non-marker files are filtered out via
 *  parseMarkerFilename. */
export function listMarkerFiles(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => parseMarkerFilename(n) !== null).map((n) => join(dir, n));
}

/** Ingest every marker currently present in `dir`. Returns one result
 *  per file so callers can log / aggregate. */
export function ingestAllMarkers(dir: string): IngestResult[] {
  const results: IngestResult[] = [];
  for (const path of listMarkerFiles(dir)) {
    try {
      results.push(ingestMarker(path));
    } catch (e) {
      console.warn(
        `[update-marker] failed to ingest ${basename(path)}:`,
        e instanceof Error ? e.message : e,
      );
    }
  }
  return results;
}

/** Default marker directory derived from the DB path. Returns "" for
 *  in-memory mode (tests); callers should bail out on "" rather than
 *  invoke listMarkerFiles on it. */
export function defaultMarkerDir(): string {
  const dbPath = process.env.MOOR_DB_PATH ?? join(import.meta.dir, "..", "..", "data", "moor.db");
  if (dbPath === ":memory:") return "";
  return dirname(dbPath);
}

// --- Poller scheduler -------------------------------------------------
//
// Markers can land at any time during the first few minutes after moor
// boots (the respawner is still finishing up). Fast poll catches those.
// After the fast window we back off to a slow poll so the dir scan isn't
// a constant background cost when no updates are in flight.

const FAST_POLL_MS = 5_000;
const SLOW_POLL_MS = 30_000;
const FAST_POLL_CYCLES = 24; // 24 × 5s = 2 min of fast polling

let pollHandle: ReturnType<typeof setInterval> | null = null;
let pollRunning = false;
let pollPhase: "fast" | "slow" = "fast";
let pollTickCount = 0;

/** Run one ingest pass. Single-flight via `pollRunning`. Never throws.
 *  Exported so tests can drive it directly. */
export async function runScheduledIngest(
  dir: string = defaultMarkerDir(),
): Promise<IngestResult[]> {
  if (pollRunning) {
    console.log("[update-marker] previous ingest still running; skipping this tick");
    return [];
  }
  if (dir === "") return [];
  pollRunning = true;
  try {
    const results = ingestAllMarkers(dir);
    if (results.length > 0) {
      console.log(
        `[update-marker] ingested ${results.length} marker(s); kinds: ${results.map((r) => r.kind).join(",")}`,
      );
    }
    return results;
  } catch (e) {
    console.error("[update-marker] ingest cycle failed:", e instanceof Error ? e.message : e);
    return [];
  } finally {
    pollRunning = false;
  }
}

export function startMarkerPoller(): void {
  pollPhase = "fast";
  pollTickCount = 0;
  const fastTick = () => {
    void runScheduledIngest();
    pollTickCount++;
    if (pollPhase === "fast" && pollTickCount >= FAST_POLL_CYCLES) {
      // Switch to slow poll. clearInterval + setInterval — only happens
      // once per moor lifetime so the cost is irrelevant.
      if (pollHandle !== null) clearInterval(pollHandle);
      pollPhase = "slow";
      pollHandle = setInterval(() => void runScheduledIngest(), SLOW_POLL_MS);
      console.log(`[update-marker] switched to slow poll (${SLOW_POLL_MS / 1000}s)`);
    }
  };
  pollHandle = setInterval(fastTick, FAST_POLL_MS);
  console.log(
    `[update-marker] poll started: fast ${FAST_POLL_MS / 1000}s for ${(FAST_POLL_CYCLES * FAST_POLL_MS) / 1000}s, then slow ${SLOW_POLL_MS / 1000}s`,
  );
}

export function stopMarkerPoller(): void {
  if (pollHandle !== null) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
  pollPhase = "fast";
  pollTickCount = 0;
}

/** Test-only seam: lets a test simulate "previous cycle still running"
 *  without actually running one. */
export function _setPollRunningForTest(value: boolean): void {
  pollRunning = value;
}
