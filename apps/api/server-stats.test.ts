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
  test("images.bytes uses LayersSize (deduped) — not a naive per-image sum", () => {
    // A shared 200-byte base layer would be hidden by Size-SharedSize
    // and double-counted by raw Size. LayersSize is the truth Docker uses.
    const out = parseSystemDf({
      LayersSize: 1200,
      Images: [
        { Id: "a", Size: 1000, SharedSize: 200, Containers: 1 },
        { Id: "b", Size: 500, SharedSize: 100, Containers: 0 },
      ],
    });
    expect(out.images.bytes).toBe(1200);
  });

  test("images.bytes falls back to per-image unique sum when LayersSize is absent", () => {
    const out = parseSystemDf({
      Images: [
        { Id: "a", Size: 1000, SharedSize: 200, Containers: 1 },
        { Id: "b", Size: 500, SharedSize: 100, Containers: 0 },
      ],
    });
    expect(out.images.bytes).toBe(800 + 400);
  });

  test("images.reclaimable_bytes counts only unused images, by unique bytes", () => {
    const out = parseSystemDf({
      LayersSize: 9999,
      Images: [
        { Id: "a", Size: 1000, SharedSize: 200, Containers: 1 }, // used
        { Id: "b", Size: 500, SharedSize: 100, Containers: 0 }, // unused: 400
        { Id: "c", Size: 300, SharedSize: 300, Containers: 0 }, // unused but fully shared: 0
      ],
    });
    expect(out.images.reclaimable_bytes).toBe(400);
    expect(out.images.unused_count).toBe(2);
    expect(out.images.count).toBe(3);
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

  test("volumes: RefCount==0 with UsageData is reclaimable; null UsageData is unknown, not unused", () => {
    // A volume Docker did not compute usage for must not silently count as
    // reclaimable. RefCount==0 (with UsageData present) is the explicit signal.
    const out = parseSystemDf({
      Volumes: [
        { Name: "v1", UsageData: { Size: 2048, RefCount: 1 } },
        { Name: "v2", UsageData: { Size: 4096, RefCount: 0 } },
        { Name: "v3", UsageData: { Size: -1, RefCount: 0 } }, // un-walked size
        { Name: "v4", UsageData: null }, // unknown — not unused
      ],
    });
    expect(out.volumes.bytes).toBe(2048 + 4096); // v3 contributes 0, v4 skipped
    expect(out.volumes.reclaimable_bytes).toBe(4096);
    expect(out.volumes.count).toBe(4); // count reflects all volumes
    expect(out.volumes.unused_count).toBe(2); // v2, v3 — v4 (null) is unknown
  });

  test("build cache: Shared rows are excluded from total, reclaimable, and count", () => {
    // Docker's own summary treats shared cache as not safely prunable; mirror
    // that. Of the remaining non-shared rows, only !InUse is reclaimable.
    const out = parseSystemDf({
      BuildCache: [
        { ID: "c1", Size: 1000, InUse: true, Shared: false }, // counted, not reclaimable
        { ID: "c2", Size: 500, InUse: false, Shared: false }, // counted, reclaimable
        { ID: "c3", Size: 250, InUse: false, Shared: true }, // excluded
        { ID: "c4", Size: 800, InUse: true, Shared: true }, // excluded
      ],
    });
    expect(out.build_cache.bytes).toBe(1500);
    expect(out.build_cache.reclaimable_bytes).toBe(500);
    expect(out.build_cache.count).toBe(2);
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
