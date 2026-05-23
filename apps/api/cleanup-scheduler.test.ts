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

  test("accepts positive numbers (including fractional hours for testing cadence)", () => {
    expect(parseIntervalHours("24")).toBe(24);
    expect(parseIntervalHours("0.5")).toBe(0.5);
    expect(parseIntervalHours("168")).toBe(168);
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
