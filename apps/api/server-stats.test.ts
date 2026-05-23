// Unit tests for #53 pure helpers. The route itself is exercised via smoke
// (the execSync + docker-socket bits aren't worth mocking just to assert
// glue code).

import { describe, expect, test } from "bun:test";
import { computeLoadPercent, parseLoadAvg, parseSystemDf } from "./server-stats";

describe("#53 computeLoadPercent — must match the existing cpu.percent formula", () => {
  test("matches load1m / cores rounded, clamped to 100", () => {
    expect(computeLoadPercent(0.5, 4)).toBe(13); // 12.5 rounds to 13
    expect(computeLoadPercent(2, 4)).toBe(50);
    expect(computeLoadPercent(4, 4)).toBe(100);
    expect(computeLoadPercent(10, 4)).toBe(100); // clamped
  });

  test("guards against bad inputs without throwing", () => {
    expect(computeLoadPercent(Number.NaN, 4)).toBe(0);
    expect(computeLoadPercent(1, 0)).toBe(0);
    expect(computeLoadPercent(1, -1)).toBe(0);
  });
});

describe("#53 parseLoadAvg", () => {
  test("returns the 1-minute field of /proc/loadavg", () => {
    expect(parseLoadAvg("0.42 0.55 0.50 1/123 4567")).toBeCloseTo(0.42);
  });

  test("returns NaN for malformed input — caller decides the fallback", () => {
    expect(Number.isNaN(parseLoadAvg(""))).toBe(true);
    expect(Number.isNaN(parseLoadAvg("not-a-number"))).toBe(true);
  });
});

describe("#53 parseSystemDf", () => {
  test("aggregates images: unique-bytes sum and unused-only reclaimable", () => {
    const out = parseSystemDf({
      Images: [
        { Id: "a", Size: 1000, SharedSize: 200, Containers: 1 }, // used: 800 unique, not reclaimable
        { Id: "b", Size: 500, SharedSize: 100, Containers: 0 }, // unused: 400 unique, reclaimable
        { Id: "c", Size: 300, SharedSize: 300, Containers: 0 }, // unused, but fully shared -> 0
      ],
    });
    expect(out.images.bytes).toBe(800 + 400 + 0);
    expect(out.images.reclaimable_bytes).toBe(400);
    expect(out.images.count).toBe(3);
    expect(out.images.unused_count).toBe(2);
  });

  test("aggregates containers: only non-running rows are reclaimable", () => {
    const out = parseSystemDf({
      Containers: [
        { Id: "x", SizeRw: 1000, State: "running" },
        { Id: "y", SizeRw: 500, State: "exited" },
        { Id: "z", SizeRw: 200, State: "created" },
      ],
    });
    expect(out.containers.bytes).toBe(1700);
    expect(out.containers.reclaimable_bytes).toBe(700);
    expect(out.containers.count).toBe(3);
    expect(out.containers.stopped_count).toBe(2);
  });

  test("volumes: RefCount==0 is reclaimable; un-walked Size=-1 is treated as 0", () => {
    const out = parseSystemDf({
      Volumes: [
        { Name: "v1", UsageData: { Size: 2048, RefCount: 1 } },
        { Name: "v2", UsageData: { Size: 4096, RefCount: 0 } },
        { Name: "v3", UsageData: { Size: -1, RefCount: 0 } }, // un-walked
        { Name: "v4", UsageData: null },
      ],
    });
    expect(out.volumes.bytes).toBe(2048 + 4096);
    expect(out.volumes.reclaimable_bytes).toBe(4096);
    expect(out.volumes.count).toBe(4);
    expect(out.volumes.unused_count).toBe(3); // v2, v3, v4 all have refCount==0
  });

  test("build cache: only !InUse rows reclaim, count covers all", () => {
    const out = parseSystemDf({
      BuildCache: [
        { ID: "c1", Size: 1000, InUse: true, Shared: false },
        { ID: "c2", Size: 500, InUse: false, Shared: false },
        { ID: "c3", Size: 250, InUse: false, Shared: true },
      ],
    });
    expect(out.build_cache.bytes).toBe(1750);
    expect(out.build_cache.reclaimable_bytes).toBe(750);
    expect(out.build_cache.count).toBe(3);
  });

  test("handles empty/missing arrays without throwing", () => {
    const out = parseSystemDf({});
    expect(out.images.bytes).toBe(0);
    expect(out.images.count).toBe(0);
    expect(out.containers.count).toBe(0);
    expect(out.volumes.count).toBe(0);
    expect(out.build_cache.count).toBe(0);
  });
});
