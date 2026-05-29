// Tests for #131 subsystem 4: the resource sampler. Docker fetch is injected;
// these exercise the write paths (raw counters for running, status-only for
// not-running) and the sample loop over projects.

process.env.MOOR_DB_PATH = ":memory:";

import { beforeEach, describe, expect, test } from "bun:test";
import type { DockerStatsPayload } from "./container-stats";

const { default: db } = await import("./db");
const { sampleOnce, writeProjectSample, writeHostSample } = await import("./metrics-sampler");

import type { StatsFetcher } from "./metrics-sampler";

function makeProject(name: string, containerId: string | null): number {
  const row = db
    .query("INSERT INTO projects (name, container_id) VALUES (?, ?) RETURNING id")
    .get(name, containerId) as { id: number };
  return row.id;
}

function samples(projectId: number) {
  return db
    .query("SELECT * FROM project_resource_samples WHERE project_id = ? ORDER BY id")
    .all(projectId) as Array<Record<string, number | string | null>>;
}

const RUNNING_PAYLOAD: DockerStatsPayload = {
  read: "2026-05-29T10:00:00Z",
  cpu_stats: {
    cpu_usage: { total_usage: 1_000_000, percpu_usage: [1, 2] },
    system_cpu_usage: 50_000_000,
    online_cpus: 4,
  },
  precpu_stats: { cpu_usage: { total_usage: 900_000 }, system_cpu_usage: 49_000_000 },
  memory_stats: { usage: 200, limit: 1000, stats: { inactive_file: 50 } },
  networks: { eth0: { rx_bytes: 111, tx_bytes: 222 } },
  blkio_stats: {
    io_service_bytes_recursive: [
      { op: "Read", value: 10 },
      { op: "Write", value: 20 },
    ],
  },
  pids_stats: { current: 7 },
};

beforeEach(() => {
  db.query("DELETE FROM project_resource_samples").run();
  db.query("DELETE FROM host_metric_samples").run();
  db.query("DELETE FROM projects").run();
});

describe("writeProjectSample", () => {
  test("running: stores RAW cumulative counters, not percentages", () => {
    const id = makeProject("p1", "cid-1");
    writeProjectSample(id, "cid-1", { ok: true, payload: RUNNING_PAYLOAD });
    const [s] = samples(id);
    expect(s.status).toBe("running");
    expect(s.cpu_total_ns).toBe(1_000_000); // raw cumulative, not the precpu delta
    expect(s.cpu_system_ns).toBe(50_000_000);
    expect(s.online_cpus).toBe(4);
    expect(s.mem_bytes).toBe(150); // 200 usage - 50 inactive_file
    expect(s.net_rx_bytes).toBe(111);
    expect(s.net_tx_bytes).toBe(222);
    expect(s.blk_read_bytes).toBe(10);
    expect(s.blk_write_bytes).toBe(20);
    expect(s.pids).toBe(7);
  });

  test("not-running: status-only row with NULL metrics (no fake zeros)", () => {
    const id = makeProject("p1", "cid-1");
    writeProjectSample(id, "cid-1", { ok: false, status: "stopped" });
    const [s] = samples(id);
    expect(s.status).toBe("stopped");
    expect(s.cpu_total_ns).toBeNull();
    expect(s.mem_bytes).toBeNull();
    expect(s.net_rx_bytes).toBeNull();
    expect(s.pids).toBeNull();
  });
});

describe("sampleOnce", () => {
  test("walks every project with a container_id and records one sample each", async () => {
    const a = makeProject("a", "cid-a");
    const b = makeProject("b", "cid-b");
    makeProject("c", null); // no container -> skipped

    const fetcher: StatsFetcher = async (cid) =>
      cid === "cid-a" ? { ok: true, payload: RUNNING_PAYLOAD } : { ok: false, status: "missing" };

    await sampleOnce(fetcher);

    expect(samples(a)).toHaveLength(1);
    expect(samples(a)[0].status).toBe("running");
    expect(samples(b)).toHaveLength(1);
    expect(samples(b)[0].status).toBe("missing");
  });
});

describe("writeHostSample", () => {
  test("stores percent gauges + container counts", () => {
    writeHostSample({
      cpu_percent: 12.5,
      cpu_cores: 4,
      mem_percent: 60,
      disk_percent: 30,
      containers_running: 2,
      containers_total: 3,
    });
    const row = db.query("SELECT * FROM host_metric_samples").get() as Record<string, number>;
    expect(row.cpu_percent).toBe(12.5);
    expect(row.mem_percent).toBe(60);
    expect(row.containers_running).toBe(2);
  });
});
