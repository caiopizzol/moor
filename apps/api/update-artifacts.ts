// #98: sweep stale .update-{context,override,rollback}-<id>.{json,yml}
// files from /app/data once their matching audit row reaches a
// terminal state. moor's apply path writes these to coordinate with
// the respawner; nothing cleans them up after the update finishes,
// so /app/data accumulates them across releases.
//
// Two trigger points:
//   - One-shot sweep at startup (after marker ingestion + stale-audit
//     sweep). Catches anything left by a crash, manual SQL finalize,
//     or pre-#98 history.
//   - Targeted sweep after each successful marker ingestion (just the
//     three files for that audit_id; no dir scan). The common path.
//
// We intentionally don't periodic-sweep. Startup + on-finalize covers
// every case the operator surface generates. A long-running moor with
// only failed orphans would still see them swept at next restart.
//
// Filename parsing mirrors the strictness in update-marker.ts:
// decimal-positive-integer audit_id, exact prefix/suffix, no leading
// zeros, no scientific notation. Anything else gets ignored (might
// be an operator's own file we shouldn't touch).

import { readdirSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import db from "./db";

const ARTIFACT_KINDS = ["context", "override", "rollback"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

type Spec = { kind: ArtifactKind; prefix: string; suffix: string };
const SPECS: readonly Spec[] = [
  { kind: "context", prefix: ".update-context-", suffix: ".json" },
  { kind: "override", prefix: ".update-override-", suffix: ".yml" },
  { kind: "rollback", prefix: ".update-rollback-", suffix: ".yml" },
];

// Same shape as update-marker.ts: only decimal positive integers,
// no leading zeros, no scientific notation. Keeps filename → audit_id
// bijective so we never confuse `.update-context-001.json` with
// `.update-context-1.json`.
const AUDIT_ID_PATTERN = /^[1-9]\d*$/;

/** Pure: parse an artifact filename into `{ kind, audit_id }` or null
 *  when it doesn't match any of the three documented patterns. */
export function parseArtifactFilename(
  name: string,
): { kind: ArtifactKind; audit_id: number } | null {
  for (const spec of SPECS) {
    if (!name.startsWith(spec.prefix) || !name.endsWith(spec.suffix)) continue;
    const middle = name.slice(spec.prefix.length, -spec.suffix.length);
    if (!AUDIT_ID_PATTERN.test(middle)) return null;
    return { kind: spec.kind, audit_id: Number(middle) };
  }
  return null;
}

/** Pure helper to build the expected filename for a given kind+id.
 *  Used by sweepArtifactsForAudit (targeted, post-finalize). */
export function artifactFilename(kind: ArtifactKind, auditId: number): string {
  const spec = SPECS.find((s) => s.kind === kind);
  if (!spec) throw new Error(`unknown artifact kind: ${kind}`);
  return `${spec.prefix}${auditId}${spec.suffix}`;
}

const TERMINAL_STATES = new Set(["success", "failed", "rolled_back", "rollback_failed", "crashed"]);

export type SweepResult = {
  deleted: string[];
  skipped_in_progress: number[];
  skipped_unknown_audit: number[];
};

/** Targeted sweep for one audit_id. Use after marker ingestion
 *  finalizes a row: we know exactly which files belong to it and
 *  whether the row is terminal, so this is O(1) on the filesystem.
 *  No DB read needed — callers pass `is_terminal` explicitly. */
export function sweepArtifactsForAudit(
  dir: string,
  auditId: number,
  isTerminal: boolean,
): string[] {
  if (!isTerminal) return [];
  const deleted: string[] = [];
  for (const spec of SPECS) {
    const path = join(dir, `${spec.prefix}${auditId}${spec.suffix}`);
    try {
      unlinkSync(path);
      deleted.push(path);
    } catch {
      // File not present — nothing to do. We don't distinguish ENOENT
      // from permission errors here because we're best-effort; the
      // startup sweep will catch leftovers on next boot.
    }
  }
  return deleted;
}

/** Full directory scan + delete. Used at startup AND as the
 *  catch-all if anyone bypasses sweepArtifactsForAudit. Returns
 *  counts so callers can log. */
export function sweepAllArtifacts(dir: string): SweepResult {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { deleted: [], skipped_in_progress: [], skipped_unknown_audit: [] };
  }

  const deleted: string[] = [];
  const skippedInProgress = new Set<number>();
  const skippedUnknownAudit = new Set<number>();

  // Cache audit states in one query to avoid N round-trips.
  type AuditRow = { id: number; state: string };
  const ids = new Set<number>();
  const parsed = names
    .map((n) => ({ n, m: parseArtifactFilename(n) }))
    .filter((x): x is { n: string; m: { kind: ArtifactKind; audit_id: number } } => x.m !== null);
  for (const p of parsed) ids.add(p.m.audit_id);
  if (ids.size === 0) {
    return { deleted: [], skipped_in_progress: [], skipped_unknown_audit: [] };
  }
  const placeholders = Array.from(ids, () => "?").join(",");
  const stateById = new Map<number, string>();
  for (const row of db
    .query(`SELECT id, state FROM update_audit WHERE id IN (${placeholders})`)
    .all(...ids) as AuditRow[]) {
    stateById.set(row.id, row.state);
  }

  for (const { n, m } of parsed) {
    const state = stateById.get(m.audit_id);
    if (state === undefined) {
      // Unknown audit row: minimal-PR scope per #98 is "skip + warn,
      // manual cleanup only." A 24h quarantine policy could layer on
      // later if accumulating orphans becomes a real problem.
      skippedUnknownAudit.add(m.audit_id);
      continue;
    }
    if (!TERMINAL_STATES.has(state)) {
      skippedInProgress.add(m.audit_id);
      continue;
    }
    const path = join(dir, n);
    try {
      unlinkSync(path);
      deleted.push(path);
    } catch (e) {
      console.warn(
        `[update-artifacts] failed to unlink ${basename(path)}:`,
        e instanceof Error ? e.message : e,
      );
    }
  }

  return {
    deleted,
    skipped_in_progress: [...skippedInProgress].sort((a, b) => a - b),
    skipped_unknown_audit: [...skippedUnknownAudit].sort((a, b) => a - b),
  };
}
