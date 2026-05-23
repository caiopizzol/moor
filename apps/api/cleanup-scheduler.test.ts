// Unit tests for #59 scheduler. The interval ticking and Docker round-
// trip are exercised by live smoke; here we test the env-parsing rules
// and the overlap-guard semantics.

process.env.MOOR_DB_PATH = ":memory:";

import { describe, expect, test } from "bun:test";

const { _setCycleRunningForTest, parseIntervalHours, runScheduledCleanup } = await import(
  "./cleanup-scheduler"
);

describe("#59 parseIntervalHours — env-driven, off by default", () => {
  test("returns null when the env var is unset or empty", () => {
    expect(parseIntervalHours(undefined)).toBeNull();
    expect(parseIntervalHours("")).toBeNull();
  });

  test("returns null for non-numeric, NaN, or zero/negative values", () => {
    expect(parseIntervalHours("nope")).toBeNull();
    expect(parseIntervalHours("0")).toBeNull();
    expect(parseIntervalHours("-1")).toBeNull();
    expect(parseIntervalHours("Infinity")).toBeNull();
  });

  test("accepts positive numbers within the valid range", () => {
    expect(parseIntervalHours("24")).toBe(24);
    expect(parseIntervalHours("0.5")).toBe(0.5);
    expect(parseIntervalHours("168")).toBe(168);
  });

  test("rejects intervals above setInterval ms cap — would silently become a tight loop", () => {
    // setInterval clamps any ms > 2_147_483_647 (~596h) to 1ms with a
    // TimeoutOverflowWarning. An operator setting "monthly-ish" 720h
    // would unknowingly hammer cleanup continuously.
    expect(parseIntervalHours("720")).toBeNull();
    expect(parseIntervalHours("1000")).toBeNull();
  });

  test("rejects intervals below 1 minute — never useful, only misconfiguration", () => {
    expect(parseIntervalHours("0.0001")).toBeNull(); // 0.36 seconds
    expect(parseIntervalHours("0.01")).toBeNull(); // 36 seconds
  });

  test("just-above-floor and just-below-ceiling values are accepted", () => {
    // 1 minute = 1/60 hours ≈ 0.01666...
    expect(parseIntervalHours(`${1 / 60}`)).toBe(1 / 60);
    // Just under 596.523h (the cap).
    expect(parseIntervalHours("596")).toBe(596);
  });
});

describe("#59 runScheduledCleanup overlap guard", () => {
  test("skips when a previous cycle is still running — never overlaps", async () => {
    _setCycleRunningForTest(true);
    // If this didn't skip, it would call planCleanup against the docker
    // socket (which isn't reachable in test) and throw. The fact that it
    // returns cleanly proves the early-skip branch ran.
    await runScheduledCleanup();
    _setCycleRunningForTest(false);
    expect(true).toBe(true);
  });
});
