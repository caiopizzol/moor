// Unit tests for #52 pure helpers. Fixtures mirror the
// /containers/:id/stats?stream=false shape Docker returns on Linux.

import { describe, expect, test } from "bun:test";
import {
  buildStatsResponse,
  computeCpuPercent,
  computeMemory,
  isStoppedPayload,
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

  test("missing online_cpus falls back to percpu_usage.length (Docker CLI behavior)", () => {
    // Older daemons don't set online_cpus; docker stats uses the percpu_usage
    // array length as the cpu count. cpu_delta=50, system_delta=100, cpus=4,
    // pct = (50/100) * 4 * 100 = 200.
    expect(
      computeCpuPercent({
        cpu_stats: {
          cpu_usage: { total_usage: 150, percpu_usage: [0, 0, 0, 0] },
          system_cpu_usage: 200,
        },
        precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 100 },
      }),
    ).toBe(200);
  });

  test("returns 0 only when both online_cpus and percpu_usage are absent", () => {
    expect(
      computeCpuPercent({
        cpu_stats: { cpu_usage: { total_usage: 150 }, system_cpu_usage: 200 },
        precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 100 },
      }),
    ).toBe(0);
  });
});

describe("#52 computeMemory — matches docker stats calculateMemUsageUnixNoCache", () => {
  test("cgroup v2: subtracts inactive_file from usage", () => {
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

  test("cgroup v1: prefers total_inactive_file over inactive_file", () => {
    // cgroup v1 reports both keys; total_inactive_file is the authoritative
    // one (the non-`total_` variant excludes child cgroup memory).
    const m = computeMemory({
      memory_stats: {
        usage: 1_000_000,
        limit: 4_000_000,
        stats: { total_inactive_file: 300_000, inactive_file: 200_000 },
      },
    });
    expect(m.bytes).toBe(700_000);
  });

  test("falls through to raw usage when no inactive_file is reported", () => {
    // Avoid the legacy `cache` fallback (Docker 19.03 behavior overstates).
    const m = computeMemory({
      memory_stats: { usage: 1_000_000, limit: 4_000_000, stats: {} },
    });
    expect(m.bytes).toBe(1_000_000);
  });

  test("falls back to raw usage when inactive_file >= usage (matches Docker CLI)", () => {
    // Docker CLI's calculateMemUsageUnixNoCache only subtracts inactive when
    // it's *less than* usage; otherwise it returns raw usage. Clamping to 0
    // here would silently misreport an active container as idle on rare
    // cgroup edges where the kernel reports inactive >= usage.
    const m = computeMemory({
      memory_stats: { usage: 100, limit: 1000, stats: { inactive_file: 200 } },
    });
    expect(m.bytes).toBe(100);
    expect(m.percent).toBe(10);
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
  test("classifies by first char case-insensitively (R/r → read, W/w → write)", () => {
    // Different Docker versions have emitted "Read"/"read"/"r" etc.; CLI
    // classifies by the first character case-insensitively.
    expect(
      sumBlockIo({
        blkio_stats: {
          io_service_bytes_recursive: [
            { op: "Read", value: 1000 },
            { op: "write", value: 500 }, // lowercase
            { op: "r", value: 250 }, // single char
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

describe("#52 isStoppedPayload — detect exited container's /stats response", () => {
  // Real fixture from a stopped (exit 137) container on the production host.
  // Docker returns 200 with `read` = Go zero-time and system_cpu_usage = null.
  test("zero-time `read` field is the explicit not-running signal", () => {
    expect(
      isStoppedPayload({
        read: "0001-01-01T00:00:00Z",
        cpu_stats: { cpu_usage: { total_usage: 0 } },
        memory_stats: {},
      }),
    ).toBe(true);
  });

  test("null system_cpu_usage also signals not-running", () => {
    expect(
      isStoppedPayload({
        read: "2026-05-23T15:00:00Z",
        cpu_stats: { cpu_usage: { total_usage: 0 } },
        memory_stats: {},
      }),
    ).toBe(true);
  });

  test("running container with both fields populated is not stopped", () => {
    expect(
      isStoppedPayload({
        read: "2026-05-23T15:00:00Z",
        cpu_stats: {
          cpu_usage: { total_usage: 100 },
          system_cpu_usage: 1000,
          online_cpus: 4,
        },
        memory_stats: { usage: 1000, limit: 4000 },
      }),
    ).toBe(false);
  });
});
