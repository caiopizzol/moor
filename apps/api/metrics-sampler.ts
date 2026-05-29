// #131 subsystem 4: project observability sampler. A sibling loop to the
// status reconciler — deliberately NOT folded into it. The reconciler is the
// lifecycle-truth loop with a 5s inspect; stats?stream=false is heavier (10s
// timeout here, matching the live route) and a slow or over-large sampling
// cycle must never delay lifecycle freshness. So this gets its own cadence,
// its own timeout, and its own single-flight guard.
//
// Stores RAW cumulative counters (see extractRawSample): the history query
// derives CPU averages and network/block rates from deltas between samples,
// segmented by container_id (Docker resets these on container recreation).
// Non-running containers record a status-only row with NULL metrics — gaps
// stay honest, never fake zeros.
//
// v1 samples projects sequentially. The single-flight guard means a host with
// enough containers to overrun the interval simply skips ticks rather than
// piling up; a bounded-concurrency fan-out can come later if that bites. The
// loop logs when it skips so the degradation isn't silent.

import { type DockerStatsPayload, extractRawSample, isStoppedPayload } from "./container-stats";
import db from "./db";
import { SOCKET as SOCKET_PATH } from "./docker";

const SAMPLE_INTERVAL_MS = 60_000;
const STATS_TIMEOUT_MS = 10_000;
// Host metrics change slowly and the gather is heavier (proc reads + docker
// df); sample every Nth project tick rather than every minute.
const HOST_SAMPLE_EVERY_N = 5;

export type SampleStatus = "running" | "stopped" | "missing" | "docker_error";

export type StatsFetchResult =
  | { ok: true; payload: DockerStatsPayload }
  | { ok: false; status: Exclude<SampleStatus, "running"> };

export type StatsFetcher = (containerId: string) => Promise<StatsFetchResult>;

/** Real Docker stats fetch. Maps 404 -> missing, other non-OK -> docker_error,
 *  the exited-container 200 payload -> stopped, otherwise a running payload. */
export const realStatsFetch: StatsFetcher = async (containerId) => {
  try {
    const res = await fetch(
      `http://localhost/v1.44/containers/${encodeURIComponent(containerId)}/stats?stream=false`,
      { unix: SOCKET_PATH, signal: AbortSignal.timeout(STATS_TIMEOUT_MS) },
    );
    if (res.status === 404) return { ok: false, status: "missing" };
    if (!res.ok) return { ok: false, status: "docker_error" };
    const payload = (await res.json()) as DockerStatsPayload;
    if (isStoppedPayload(payload)) return { ok: false, status: "stopped" };
    return { ok: true, payload };
  } catch {
    return { ok: false, status: "docker_error" };
  }
};

// Host sample stores percent gauges + container counts. Raw host bytes aren't
// readily available (the server route's gatherers return formatted strings),
// and host trend is well served by percentages; per-project precision is where
// the raw counters matter.
export type HostSample = {
  cpu_percent: number | null;
  cpu_cores: number | null;
  mem_percent: number | null;
  disk_percent: number | null;
  containers_running: number | null;
  containers_total: number | null;
};
export type HostStatsFetcher = () => Promise<HostSample | null>;

export function writeProjectSample(
  projectId: number,
  containerId: string,
  result: StatsFetchResult,
): void {
  const now = Date.now();
  if (!result.ok) {
    db.query(
      `INSERT INTO project_resource_samples (project_id, container_id, sampled_at_ms, status)
       VALUES (?, ?, ?, ?)`,
    ).run(projectId, containerId, now, result.status);
    return;
  }
  const s = extractRawSample(result.payload);
  db.query(
    `INSERT INTO project_resource_samples
       (project_id, container_id, sampled_at_ms, status,
        cpu_total_ns, cpu_system_ns, online_cpus,
        mem_bytes, mem_limit_bytes,
        net_rx_bytes, net_tx_bytes, blk_read_bytes, blk_write_bytes, pids)
     VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    projectId,
    containerId,
    now,
    s.cpu_total_ns,
    s.cpu_system_ns,
    s.online_cpus,
    s.mem_bytes,
    s.mem_limit_bytes,
    s.net_rx_bytes,
    s.net_tx_bytes,
    s.blk_read_bytes,
    s.blk_write_bytes,
    s.pids,
  );
}

export function writeHostSample(h: HostSample): void {
  db.query(
    `INSERT INTO host_metric_samples
       (sampled_at_ms, cpu_percent, cpu_cores, mem_percent, disk_percent,
        containers_running, containers_total)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    Date.now(),
    h.cpu_percent,
    h.cpu_cores,
    h.mem_percent,
    h.disk_percent,
    h.containers_running,
    h.containers_total,
  );
}

let cycleRunning = false;

/** One sampling pass over every project with a container_id. Fetcher is
 *  injectable for tests; production uses realStatsFetch. */
export async function sampleOnce(fetcher: StatsFetcher = realStatsFetch): Promise<void> {
  if (cycleRunning) {
    console.log("[metrics-sampler] previous cycle still running; skipping this tick");
    return;
  }
  cycleRunning = true;
  try {
    const rows = db
      .query("SELECT id, container_id FROM projects WHERE container_id IS NOT NULL")
      .all() as Array<{ id: number; container_id: string }>;
    for (const row of rows) {
      const result = await fetcher(row.container_id);
      writeProjectSample(row.id, row.container_id, result);
    }
  } finally {
    cycleRunning = false;
  }
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let tickCount = 0;

export function startMetricsSampler(hostFetcher: HostStatsFetcher): void {
  console.log(`[metrics-sampler] enabled: resource samples every ${SAMPLE_INTERVAL_MS / 1000}s`);
  tickCount = 0;
  intervalHandle = setInterval(() => {
    void sampleOnce();
    tickCount += 1;
    if (tickCount % HOST_SAMPLE_EVERY_N === 0) {
      void hostFetcher()
        .then((h) => {
          if (h) writeHostSample(h);
        })
        .catch(() => {
          // A failed host gather is a skipped sample, not a crash. The gap is
          // honest — nothing is written.
        });
    }
  }, SAMPLE_INTERVAL_MS);
}

export function stopMetricsSampler(): void {
  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
