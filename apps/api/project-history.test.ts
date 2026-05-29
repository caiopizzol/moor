// Tests for #131 subsystem 6: history derivation. The contract that matters is
// counter handling — CPU averaged from cumulative deltas, net/block as rates,
// and nulls (not bogus spikes) across container recreation / counter resets.

process.env.MOOR_DB_PATH = ":memory:";

import { describe, expect, test } from "bun:test";

const { deriveHistory } = await import("./project-history");

import type { ProjectEventRow, ResourceSampleRow } from "./project-history";

function sample(over: Partial<ResourceSampleRow>): ResourceSampleRow {
  return {
    container_id: "c1",
    sampled_at_ms: 0,
    status: "running",
    cpu_total_ns: null,
    cpu_system_ns: null,
    online_cpus: null,
    mem_bytes: null,
    mem_limit_bytes: null,
    net_rx_bytes: null,
    net_tx_bytes: null,
    blk_read_bytes: null,
    blk_write_bytes: null,
    pids: null,
    ...over,
  };
}

describe("deriveHistory — CPU", () => {
  test("averages CPU across the inter-sample interval from cumulative counters", () => {
    // 1 core. Over the interval, cpu used 5 of 10 system units -> 50%.
    const samples = [
      sample({ sampled_at_ms: 0, cpu_total_ns: 100, cpu_system_ns: 1000, online_cpus: 1 }),
      sample({ sampled_at_ms: 60_000, cpu_total_ns: 105, cpu_system_ns: 1010, online_cpus: 1 }),
    ];
    const { samples: d } = deriveHistory(samples, []);
    expect(d[0].cpu_percent).toBeNull(); // first sample, no interval
    expect(d[1].cpu_percent).toBe(50);
  });

  test("first sample and post-reset yield null CPU, not a spike", () => {
    const samples = [
      sample({
        sampled_at_ms: 0,
        container_id: "c1",
        cpu_total_ns: 900,
        cpu_system_ns: 1000,
        online_cpus: 1,
      }),
      // container recreated: counter resets to a small value; delta would be
      // negative -> null, not a huge bogus number
      sample({
        sampled_at_ms: 60_000,
        container_id: "c2",
        cpu_total_ns: 5,
        cpu_system_ns: 10,
        online_cpus: 1,
      }),
    ];
    const { samples: d } = deriveHistory(samples, []);
    expect(d[0].cpu_percent).toBeNull();
    expect(d[1].cpu_percent).toBeNull(); // different container_id
  });
});

describe("deriveHistory — rates and resets", () => {
  test("network/block emitted as per-second rates over the interval", () => {
    const samples = [
      sample({ sampled_at_ms: 0, net_rx_bytes: 1000, blk_read_bytes: 500 }),
      sample({ sampled_at_ms: 10_000, net_rx_bytes: 3000, blk_read_bytes: 1500 }),
    ];
    const { samples: d } = deriveHistory(samples, []);
    expect(d[1].net_rx_rate).toBe(200); // 2000 bytes / 10s
    expect(d[1].blk_read_rate).toBe(100); // 1000 / 10s
  });

  test("counter going backwards (reset) -> null rate, not negative", () => {
    const samples = [
      sample({ sampled_at_ms: 0, container_id: "c1", net_rx_bytes: 5000 }),
      sample({ sampled_at_ms: 10_000, container_id: "c1", net_rx_bytes: 100 }),
    ];
    const { samples: d } = deriveHistory(samples, []);
    expect(d[1].net_rx_rate).toBeNull();
  });

  test("not-running sample carries null metrics (honest gap)", () => {
    const samples = [
      sample({ sampled_at_ms: 0, status: "running", mem_bytes: 100 }),
      sample({ sampled_at_ms: 60_000, status: "stopped", mem_bytes: null }),
    ];
    const { samples: d } = deriveHistory(samples, []);
    expect(d[1].mem_bytes).toBeNull();
    expect(d[1].cpu_percent).toBeNull();
  });
});

describe("deriveHistory — summary", () => {
  test("aggregates CPU avg/max, mem max, net totals, and event counts", () => {
    const samples = [
      sample({
        sampled_at_ms: 0,
        cpu_total_ns: 0,
        cpu_system_ns: 0,
        online_cpus: 1,
        mem_bytes: 100,
        net_rx_bytes: 0,
      }),
      sample({
        sampled_at_ms: 60_000,
        cpu_total_ns: 2,
        cpu_system_ns: 10,
        online_cpus: 1,
        mem_bytes: 300,
        net_rx_bytes: 500,
      }),
      sample({
        sampled_at_ms: 120_000,
        cpu_total_ns: 6,
        cpu_system_ns: 20,
        online_cpus: 1,
        mem_bytes: 200,
        net_rx_bytes: 900,
      }),
    ];
    const events: ProjectEventRow[] = [
      {
        occurred_at_ms: 10,
        source: "docker_event",
        action: "oom",
        container_id: "c1",
        time_nano: 1,
      },
      {
        occurred_at_ms: 20,
        source: "docker_event",
        action: "die",
        container_id: "c1",
        time_nano: 2,
      },
      {
        occurred_at_ms: 30,
        source: "docker_event",
        action: "oom",
        container_id: "c1",
        time_nano: 3,
      },
    ];
    const { summary } = deriveHistory(samples, events, true);
    expect(summary.sample_count).toBe(3);
    expect(summary.running_sample_count).toBe(3);
    expect(summary.cpu_percent_max).toBe(40); // 2nd interval: 4/10*1*100
    expect(summary.mem_bytes_max).toBe(300);
    expect(summary.net_rx_bytes_total).toBe(900); // 500 + 400
    expect(summary.event_counts.oom).toBe(2);
    expect(summary.event_counts.die).toBe(1);
    expect(summary.has_gap).toBe(true);
  });
});
