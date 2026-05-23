// Unit tests for #52 pure helpers. Fixtures mirror the
// /containers/:id/stats?stream=false shape Docker returns on Linux.

import { describe, expect, test } from "bun:test";
import {
  buildStatsResponse,
  computeCpuPercent,
  computeMemory,
  sumBlockIo,
  sumNetwork,
} from "./container-stats";

describe("#52 computeCpuPercent", () => {
  test("applies the documented (cpu_delta / system_delta) * cores * 100 formula", () => {
    // cpu_delta = 50, system_delta = 100, online_cpus = 4
    // pct = (50/100) * 4 * 100 = 200
    expect(
      computeCpuPercent({
        cpu_stats: {
          cpu_usage: { total_usage: 150 },
          system_cpu_usage: 200,
          online_cpus: 4,
        },
        precpu_stats: {
          cpu_usage: { total_usage: 100 },
          system_cpu_usage: 100,
        },
      }),
    ).toBe(200);
  });

  test("idle container: cpu_delta=0 returns 0% (not NaN)", () => {
    expect(
      computeCpuPercent({
        cpu_stats: {
          cpu_usage: { total_usage: 100 },
          system_cpu_usage: 200,
          online_cpus: 4,
        },
        precpu_stats: {
          cpu_usage: { total_usage: 100 },
          system_cpu_usage: 100,
        },
      }),
    ).toBe(0);
  });

  test("daemon's prior sample missing (system_delta=0) returns 0 — no divide-by-zero", () => {
    expect(
      computeCpuPercent({
        cpu_stats: {
          cpu_usage: { total_usage: 100 },
          system_cpu_usage: 100,
          online_cpus: 4,
        },
        precpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 100 },
      }),
    ).toBe(0);
  });

  test("missing online_cpus returns 0 — can't normalize without it", () => {
    expect(
      computeCpuPercent({
        cpu_stats: {
          cpu_usage: { total_usage: 100 },
          system_cpu_usage: 200,
        },
        precpu_stats: { cpu_usage: { total_usage: 50 }, system_cpu_usage: 100 },
      }),
    ).toBe(0);
  });
});

describe("#52 computeMemory", () => {
  test("subtracts inactive_file (cgroup v2) from usage", () => {
    const m = computeMemory({
      memory_stats: {
        usage: 1_000_000,
        limit: 4_000_000,
        stats: { inactive_file: 200_000 },
      },
    });
    expect(m.bytes).toBe(800_000);
    expect(m.limit_bytes).toBe(4_000_000);
    expect(m.percent).toBe(20);
  });

  test("falls back to cache (cgroup v1) when inactive_file is absent", () => {
    const m = computeMemory({
      memory_stats: {
        usage: 1_000_000,
        limit: 4_000_000,
        stats: { cache: 100_000 },
      },
    });
    expect(m.bytes).toBe(900_000);
  });

  test("clamps bytes to 0 if cache > usage (rare cgroup edge)", () => {
    const m = computeMemory({
      memory_stats: {
        usage: 100,
        limit: 1000,
        stats: { inactive_file: 200 },
      },
    });
    expect(m.bytes).toBe(0);
    expect(m.percent).toBe(0);
  });

  test("percent stays 0 when limit is missing — not Infinity", () => {
    const m = computeMemory({
      memory_stats: { usage: 1000, stats: { inactive_file: 0 } },
    });
    expect(m.percent).toBe(0);
  });
});

describe("#52 sumNetwork", () => {
  test("sums rx/tx across all interfaces", () => {
    expect(
      sumNetwork({
        networks: {
          eth0: { rx_bytes: 100, tx_bytes: 50 },
          eth1: { rx_bytes: 25, tx_bytes: 10 },
        },
      }),
    ).toEqual({ rx_bytes: 125, tx_bytes: 60 });
  });

  test("host-networking container has no `networks` field — returns zeros", () => {
    expect(sumNetwork({})).toEqual({ rx_bytes: 0, tx_bytes: 0 });
  });
});

describe("#52 sumBlockIo", () => {
  test("splits Read vs Write from io_service_bytes_recursive", () => {
    expect(
      sumBlockIo({
        blkio_stats: {
          io_service_bytes_recursive: [
            { op: "Read", value: 1000 },
            { op: "Write", value: 500 },
            { op: "Read", value: 250 },
            { op: "Sync", value: 9999 }, // ignored
          ],
        },
      }),
    ).toEqual({ read_bytes: 1250, write_bytes: 500 });
  });

  test("cgroup v2 empty array — returns zeros, doesn't fabricate", () => {
    expect(sumBlockIo({ blkio_stats: { io_service_bytes_recursive: [] } })).toEqual({
      read_bytes: 0,
      write_bytes: 0,
    });
    expect(sumBlockIo({ blkio_stats: { io_service_bytes_recursive: null } })).toEqual({
      read_bytes: 0,
      write_bytes: 0,
    });
  });
});

describe("#52 buildStatsResponse — full route shape", () => {
  test("composes all derived numbers into the wire response", () => {
    const out = buildStatsResponse({
      cpu_stats: {
        cpu_usage: { total_usage: 200 },
        system_cpu_usage: 300,
        online_cpus: 2,
      },
      precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 200 },
      memory_stats: { usage: 500, limit: 1000, stats: { inactive_file: 100 } },
      networks: { eth0: { rx_bytes: 10, tx_bytes: 20 } },
      blkio_stats: { io_service_bytes_recursive: [{ op: "Write", value: 7 }] },
      pids_stats: { current: 3 },
    });
    expect(out).toEqual({
      running: true,
      cpu_percent: 200, // (100/100) * 2 * 100
      memory_bytes: 400,
      memory_limit_bytes: 1000,
      memory_percent: 40,
      network_rx_bytes: 10,
      network_tx_bytes: 20,
      block_read_bytes: 0,
      block_write_bytes: 7,
      pids: 3,
    });
  });
});
