// Tests for #79 drain mode. Pure helpers tested directly; DB helpers
// against an in-memory SQLite; the boot auto-clear path tested via
// the public API with explicit version injection. No mocks needed.

process.env.MOOR_DB_PATH = ":memory:";

import { beforeEach, describe, expect, test } from "bun:test";

const { default: db } = await import("./db");
const {
  DRAIN_TTL_DEFAULT_MINUTES,
  DRAIN_TTL_MAX_MINUTES,
  DRAIN_TTL_MIN_MINUTES,
  disableDrain,
  drainResponseBody,
  enableDrain,
  getDrainState,
  isActive,
  maybeAutoClearForBoot,
  parseTtlMinutes,
  requireNotDraining,
  shouldClearForVersion,
} = await import("./drain");

const EMPTY = {
  enabled: false,
  reason: null,
  started_at: null,
  expires_at: null,
  clear_after_version: null,
};

describe("#79 parseTtlMinutes", () => {
  test("undefined/null/non-number → default", () => {
    expect(parseTtlMinutes(undefined)).toBe(DRAIN_TTL_DEFAULT_MINUTES);
    expect(parseTtlMinutes(null)).toBe(DRAIN_TTL_DEFAULT_MINUTES);
    expect(parseTtlMinutes(Number.NaN)).toBe(DRAIN_TTL_DEFAULT_MINUTES);
    expect(parseTtlMinutes(Number.POSITIVE_INFINITY)).toBe(DRAIN_TTL_DEFAULT_MINUTES);
  });
  test("clamps below floor (3s)", () => {
    expect(parseTtlMinutes(0)).toBe(DRAIN_TTL_MIN_MINUTES);
    expect(parseTtlMinutes(-5)).toBe(DRAIN_TTL_MIN_MINUTES);
  });
  test("clamps above ceiling (7 days)", () => {
    expect(parseTtlMinutes(99999)).toBe(DRAIN_TTL_MAX_MINUTES);
  });
  test("passes through valid values", () => {
    expect(parseTtlMinutes(30)).toBe(30);
    expect(parseTtlMinutes(0.1)).toBe(0.1); // 6 seconds — acceptance test value
  });
});

describe("#79 isActive (pure, with injected nowMs)", () => {
  test("disabled is always inactive", () => {
    expect(isActive({ ...EMPTY, enabled: false }, 1000)).toBe(false);
  });
  test("enabled with no expires_at is active forever", () => {
    expect(isActive({ ...EMPTY, enabled: true, expires_at: null }, 1000)).toBe(true);
  });
  test("expires_at in future → active", () => {
    const future = new Date(2_000_000).toISOString();
    expect(isActive({ ...EMPTY, enabled: true, expires_at: future }, 1_000_000)).toBe(true);
  });
  test("expires_at in past → inactive (TTL semantic)", () => {
    const past = new Date(500_000).toISOString();
    expect(isActive({ ...EMPTY, enabled: true, expires_at: past }, 1_000_000)).toBe(false);
  });
});

describe("#79 shouldClearForVersion (pure)", () => {
  test("disabled → never clears", () => {
    expect(
      shouldClearForVersion({ ...EMPTY, enabled: false, clear_after_version: "1.0.0" }, "1.0.0"),
    ).toBe(false);
  });
  test("no clear_after_version → never clears (upgrade is unrelated to this drain)", () => {
    expect(
      shouldClearForVersion({ ...EMPTY, enabled: true, clear_after_version: null }, "1.0.0"),
    ).toBe(false);
  });
  test("matching version → clears (upgrade landed)", () => {
    expect(
      shouldClearForVersion({ ...EMPTY, enabled: true, clear_after_version: "0.32.0" }, "0.32.0"),
    ).toBe(true);
  });
  test("mismatched version → keeps draining (upgrade failed, operator should see)", () => {
    expect(
      shouldClearForVersion({ ...EMPTY, enabled: true, clear_after_version: "0.32.0" }, "0.31.0"),
    ).toBe(false);
  });
});

describe("#79 drainResponseBody (pure)", () => {
  test("contract: error / reason / expires_at / hint", () => {
    const body = drainResponseBody({
      ...EMPTY,
      enabled: true,
      reason: "upgrading to 0.34",
      expires_at: "2030-01-01T00:00:00Z",
    });
    expect(body.error).toBe("moor is draining");
    expect(body.reason).toBe("upgrading to 0.34");
    expect(body.expires_at).toBe("2030-01-01T00:00:00Z");
    expect(body.hint).toContain("moor_drain_disable");
  });
});

describe("#79 enable/disable/get round-trip", () => {
  beforeEach(() => {
    db.query("DELETE FROM drain_state").run();
  });

  test("get on empty table → empty state (no row inserted)", () => {
    expect(getDrainState()).toEqual(EMPTY);
  });

  test("enable writes the row; disable clears it", () => {
    const enabled = enableDrain({ reason: "test", ttl_minutes: 30 });
    expect(enabled.enabled).toBe(true);
    expect(enabled.reason).toBe("test");
    expect(enabled.started_at).not.toBeNull();
    expect(enabled.expires_at).not.toBeNull();

    disableDrain();
    expect(getDrainState().enabled).toBe(false);
  });

  test("enable twice overwrites (not appends; this is a singleton)", () => {
    enableDrain({ reason: "first" });
    enableDrain({ reason: "second" });
    expect(getDrainState().reason).toBe("second");
    // Singleton check: only one row exists
    const count = (db.query("SELECT COUNT(*) as n FROM drain_state").get() as { n: number }).n;
    expect(count).toBe(1);
  });

  test("expires_at is set to now + ttl_minutes", () => {
    const before = Date.now();
    const state = enableDrain({ ttl_minutes: 10 });
    const after = Date.now();
    const exp = Date.parse(state.expires_at as string);
    // Allow generous bounds for slow CI; ~10 min from now is the target.
    expect(exp).toBeGreaterThanOrEqual(before + 10 * 60_000 - 10);
    expect(exp).toBeLessThanOrEqual(after + 10 * 60_000 + 10);
  });

  test("getDrainState lazily clears an expired row", () => {
    // 50ms expiry — wait past it and re-read.
    enableDrain({ ttl_minutes: 50 / 60_000 }); // 0.05 / 1200 ≈ 50ms in min units... safer to just write past expires_at directly.
    db.query("UPDATE drain_state SET expires_at = ? WHERE id = 1").run(
      new Date(Date.now() - 1000).toISOString(),
    );
    const state = getDrainState();
    expect(state.enabled).toBe(false);
    // Confirm the row was actually disabled on disk, not just hidden:
    const row = db.query("SELECT enabled FROM drain_state WHERE id = 1").get() as {
      enabled: number;
    };
    expect(row.enabled).toBe(0);
  });
});

describe("#79 maybeAutoClearForBoot", () => {
  beforeEach(() => {
    db.query("DELETE FROM drain_state").run();
  });

  test("disabled drain → no-op", () => {
    expect(maybeAutoClearForBoot("0.33.0")).toBe(false);
  });

  test("drain with no clear_after_version → no-op even on matching version", () => {
    enableDrain({ reason: "manual" });
    expect(maybeAutoClearForBoot("0.33.0")).toBe(false);
    expect(getDrainState().enabled).toBe(true);
  });

  test("clear_after_version matches running version → drain cleared", () => {
    enableDrain({ reason: "upgrade", clear_after_version: "0.34.0" });
    expect(maybeAutoClearForBoot("0.34.0")).toBe(true);
    expect(getDrainState().enabled).toBe(false);
  });

  test("clear_after_version mismatches running version → drain stays (failed upgrade)", () => {
    enableDrain({ reason: "upgrade", clear_after_version: "0.34.0" });
    expect(maybeAutoClearForBoot("0.33.1")).toBe(false);
    expect(getDrainState().enabled).toBe(true);
    expect(getDrainState().clear_after_version).toBe("0.34.0");
  });

  test("bypasses TTL auto-clear — boot path is its own semantic", () => {
    // An expired row with a matching clear_after_version still clears via
    // the boot path. (It would also clear via TTL, but the boot path is
    // for when the upgrade ACTUALLY HAPPENED, which is a separate signal
    // worth a different log message.)
    enableDrain({ reason: "upgrade", clear_after_version: "0.34.0", ttl_minutes: 30 });
    db.query("UPDATE drain_state SET expires_at = ? WHERE id = 1").run(
      new Date(Date.now() - 1000).toISOString(),
    );
    expect(maybeAutoClearForBoot("0.34.0")).toBe(true);
  });
});

describe("#79 requireNotDraining guard", () => {
  beforeEach(() => {
    db.query("DELETE FROM drain_state").run();
  });

  test("not draining → null (caller proceeds)", () => {
    expect(requireNotDraining()).toBeNull();
  });

  test("draining → 503 with documented body", async () => {
    enableDrain({ reason: "upgrading to 0.34", ttl_minutes: 30 });
    const res = requireNotDraining();
    expect(res).not.toBeNull();
    expect(res?.status).toBe(503);
    const body = (await res?.json()) as {
      error: string;
      reason: string | null;
      expires_at: string | null;
      hint: string;
    };
    expect(body.error).toBe("moor is draining");
    expect(body.reason).toBe("upgrading to 0.34");
    expect(body.expires_at).not.toBeNull();
    expect(body.hint).toContain("moor_drain_disable");
  });

  test("draining but past TTL → null (lazy clear happens on read)", () => {
    enableDrain({ reason: "stale" });
    db.query("UPDATE drain_state SET expires_at = ? WHERE id = 1").run(
      new Date(Date.now() - 1000).toISOString(),
    );
    expect(requireNotDraining()).toBeNull();
  });
});
