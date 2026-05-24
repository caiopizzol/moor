// #79: DB-backed drain mode. An operator-facing primitive that gates
// new work-against-container actions (deploys, builds, async/sync
// execs, manual cron runs, terminal upgrades) so an upgrade can wait
// for in-flight work to complete cleanly.
//
// Design notes (locked in the issue body):
//
// - Singleton row (CHECK id=1). drain_state is a single fact, not a log.
// - TTL is load-bearing. Every refusal carries expires_at so the
//   operator sees the auto-clear time without guessing. The "I forgot
//   to disable drain" failure mode is what TTL exists to prevent.
// - getDrainState() lazily clears an expired row on read. We never
//   report enabled=true with an expires_at in the past — that would
//   lie about the runtime.
// - clear_after_version handles the upgrade case cleanly: if drain was
//   enabled for an upgrade to 0.32, and the boot version is 0.32, the
//   row auto-clears. If boot version is still 0.31 (failed upgrade),
//   the row stays — operator action or TTL required.
// - Drain refuses NEW work; it never kills in-flight work. The
//   shutdown coordinator (#77) is the kill path. Drain + #77 together
//   produce a clean update window.
// - Read-only routes (moor_status, moor_logs, moor_runs, etc) keep
//   working during drain. The reconciler and cleanup scheduler keep
//   running — they aren't operator work.

import db from "./db";
import { readPackageVersion } from "./update-status";

export type DrainState = {
  enabled: boolean;
  reason: string | null;
  started_at: string | null;
  expires_at: string | null;
  clear_after_version: string | null;
};

export const DRAIN_TTL_DEFAULT_MINUTES = 30;
// Floor: 3 seconds. Lets the acceptance test (`ttl_minutes: 0.1` =
// 6s; wait 7s; refresh) be deterministic without sleeping for minutes.
export const DRAIN_TTL_MIN_MINUTES = 0.05;
// Ceiling: 7 days. Longer than this and the operator has forgotten
// drain exists — TTL stops being a safety net and becomes drift.
export const DRAIN_TTL_MAX_MINUTES = 7 * 24 * 60;

/** Pure: parse + clamp ttl_minutes input. Invalid/missing → default. */
export function parseTtlMinutes(input: number | undefined | null): number {
  if (input === undefined || input === null) return DRAIN_TTL_DEFAULT_MINUTES;
  if (typeof input !== "number" || !Number.isFinite(input)) return DRAIN_TTL_DEFAULT_MINUTES;
  if (input < DRAIN_TTL_MIN_MINUTES) return DRAIN_TTL_MIN_MINUTES;
  if (input > DRAIN_TTL_MAX_MINUTES) return DRAIN_TTL_MAX_MINUTES;
  return input;
}

/** Pure: is the row effectively drained NOW? Used by tests with an
 *  injected nowMs to avoid timing flakes. */
export function isActive(state: DrainState, nowMs: number = Date.now()): boolean {
  if (!state.enabled) return false;
  if (!state.expires_at) return true;
  return Date.parse(state.expires_at) > nowMs;
}

/** Pure: clear-on-boot eligibility. If the upgrade actually happened
 *  (running version matches clear_after_version), drain has served
 *  its purpose. If the upgrade failed (versions don't match), drain
 *  stays — operator should see "moor is draining" until they decide. */
export function shouldClearForVersion(state: DrainState, currentVersion: string): boolean {
  if (!state.enabled) return false;
  if (!state.clear_after_version) return false;
  return state.clear_after_version === currentVersion;
}

/** Pure: the 503 response body shape. Routes import drainResponseBody
 *  to keep the wire contract centralized. */
export function drainResponseBody(state: DrainState): {
  error: string;
  reason: string | null;
  expires_at: string | null;
  hint: string;
} {
  return {
    error: "moor is draining",
    reason: state.reason,
    expires_at: state.expires_at,
    hint: "use moor_drain_disable to re-enable",
  };
}

type DrainRow = {
  enabled: number;
  reason: string | null;
  started_at: string | null;
  expires_at: string | null;
  clear_after_version: string | null;
};

const EMPTY_STATE: DrainState = {
  enabled: false,
  reason: null,
  started_at: null,
  expires_at: null,
  clear_after_version: null,
};

function readRow(): DrainState {
  const row = db.query("SELECT * FROM drain_state WHERE id = 1").get() as DrainRow | null;
  if (!row) return EMPTY_STATE;
  return {
    enabled: row.enabled === 1,
    reason: row.reason,
    started_at: row.started_at,
    expires_at: row.expires_at,
    clear_after_version: row.clear_after_version,
  };
}

/** Public read API. Lazily clears an expired row so callers never see
 *  enabled=true with an expires_at in the past. All hot paths should
 *  call this, never readRow. */
export function getDrainState(): DrainState {
  const state = readRow();
  if (state.enabled && state.expires_at && Date.parse(state.expires_at) <= Date.now()) {
    disableDrain();
    return EMPTY_STATE;
  }
  return state;
}

export function enableDrain(input: {
  reason?: string;
  ttl_minutes?: number;
  clear_after_version?: string;
}): DrainState {
  const ttlMin = parseTtlMinutes(input.ttl_minutes);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMin * 60_000);
  db.query(
    `INSERT INTO drain_state (id, enabled, reason, started_at, expires_at, clear_after_version)
     VALUES (1, 1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       enabled = 1,
       reason = excluded.reason,
       started_at = excluded.started_at,
       expires_at = excluded.expires_at,
       clear_after_version = excluded.clear_after_version`,
  ).run(
    input.reason ?? null,
    now.toISOString(),
    expiresAt.toISOString(),
    input.clear_after_version ?? null,
  );
  return getDrainState();
}

export function disableDrain(): void {
  db.query(
    `INSERT INTO drain_state (id, enabled, reason, started_at, expires_at, clear_after_version)
     VALUES (1, 0, NULL, NULL, NULL, NULL)
     ON CONFLICT(id) DO UPDATE SET
       enabled = 0,
       reason = NULL,
       started_at = NULL,
       expires_at = NULL,
       clear_after_version = NULL`,
  ).run();
}

/** Boot-time check. Reads the raw row (bypassing TTL auto-clear,
 *  because the clear_after_version path is a separate cleanup
 *  semantic), and clears drain if the upgrade landed. Returns true
 *  when cleared so the caller can log. */
export function maybeAutoClearForBoot(version: string = readPackageVersion()): boolean {
  const state = readRow();
  if (shouldClearForVersion(state, version)) {
    disableDrain();
    console.log(
      `[drain] auto-cleared on boot: clear_after_version=${state.clear_after_version} matched running ${version}`,
    );
    return true;
  }
  return false;
}

/** Action-path guard. Returns null when not draining (caller
 *  proceeds), or a 503 Response with the documented body when
 *  draining. Routes call this BEFORE any other validation that has
 *  cost (Docker inspect, fetch body parse) so drained operators get
 *  fast, cheap refusals. */
export function requireNotDraining(): Response | null {
  const state = getDrainState();
  if (!isActive(state)) return null;
  return Response.json(drainResponseBody(state), { status: 503 });
}
