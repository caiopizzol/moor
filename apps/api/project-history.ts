// #131 subsystem 6: turn stored raw samples + events into a per-project
// history answer. The sampler persists cumulative counters; the meaning lives
// here, computed at query time:
//   - CPU percent is averaged across each inter-sample interval from the
//     cumulative (cpu_total_ns, cpu_system_ns) delta — NOT the instantaneous
//     1s snapshot the live route shows.
//   - network/block are cumulative-since-container-start, so we emit per-second
//     rates from the delta over the interval.
// Both are segmented by container_id: when it changes (recreation) or a counter
// goes backwards (reset), the derived value is null rather than a bogus spike.
// A null derived value is honest "can't compute across this boundary", distinct
// from a real 0 (idle).

import { cpuPercentFromDeltas } from "./container-stats";
import db from "./db";

export type ResourceSampleRow = {
  container_id: string | null;
  sampled_at_ms: number;
  status: string;
  cpu_total_ns: number | null;
  cpu_system_ns: number | null;
  online_cpus: number | null;
  mem_bytes: number | null;
  mem_limit_bytes: number | null;
  net_rx_bytes: number | null;
  net_tx_bytes: number | null;
  blk_read_bytes: number | null;
  blk_write_bytes: number | null;
  pids: number | null;
};

export type ProjectEventRow = {
  occurred_at_ms: number;
  source: string;
  action: string;
  container_id: string | null;
  time_nano: number | null;
};

export type DerivedSample = {
  sampled_at_ms: number;
  status: string;
  cpu_percent: number | null;
  mem_bytes: number | null;
  mem_percent: number | null;
  net_rx_rate: number | null;
  net_tx_rate: number | null;
  blk_read_rate: number | null;
  blk_write_rate: number | null;
  pids: number | null;
};

export type HistorySummary = {
  sample_count: number;
  running_sample_count: number;
  cpu_percent_avg: number | null;
  cpu_percent_max: number | null;
  mem_bytes_max: number | null;
  net_rx_bytes_total: number;
  net_tx_bytes_total: number;
  event_counts: Record<string, number>;
  has_gap: boolean;
};

export type ProjectHistory = {
  samples: DerivedSample[];
  events: ProjectEventRow[];
  summary: HistorySummary;
};

function rateBetween(curr: number | null, prev: number | null, dtSeconds: number): number | null {
  if (curr === null || prev === null || dtSeconds <= 0) return null;
  const delta = curr - prev;
  if (delta < 0) return null; // counter reset (container recreated/restarted)
  return Math.round((delta / dtSeconds) * 100) / 100;
}

/** Pure: derive the rate/percent series and summary from samples (ascending by
 *  sampled_at_ms) and the events in the window. gapPresent flags any
 *  docker_event_gap recorded in the window. */
export function deriveHistory(
  samples: ResourceSampleRow[],
  events: ProjectEventRow[],
  gapPresent = false,
): ProjectHistory {
  const derived: DerivedSample[] = [];
  let cpuSum = 0;
  let cpuCount = 0;
  let cpuMax: number | null = null;
  let memMax: number | null = null;
  let rxTotal = 0;
  let txTotal = 0;

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const prev = i > 0 ? samples[i - 1] : null;
    const sameContainer =
      prev !== null && prev.container_id === s.container_id && s.container_id !== null;
    const running = s.status === "running";
    const dtSeconds = prev ? (s.sampled_at_ms - prev.sampled_at_ms) / 1000 : 0;

    let cpuPercent: number | null = null;
    if (running && sameContainer && prev?.status === "running") {
      const cpuDelta = (s.cpu_total_ns ?? 0) - (prev.cpu_total_ns ?? 0);
      const sysDelta = (s.cpu_system_ns ?? 0) - (prev.cpu_system_ns ?? 0);
      const cpus = s.online_cpus ?? 0;
      // cpuDelta < 0 means the counter reset; leave null. >= 0 with a positive
      // system delta is computable (0 is a valid idle reading).
      if (cpuDelta >= 0 && sysDelta > 0 && cpus > 0) {
        cpuPercent = cpuPercentFromDeltas(cpuDelta, sysDelta, cpus);
      }
    }

    const memPercent =
      running && s.mem_bytes !== null && s.mem_limit_bytes && s.mem_limit_bytes > 0
        ? Math.round((s.mem_bytes / s.mem_limit_bytes) * 10000) / 100
        : null;

    const canRate = running && sameContainer && prev?.status === "running";
    const netRx = canRate ? rateBetween(s.net_rx_bytes, prev.net_rx_bytes, dtSeconds) : null;
    const netTx = canRate ? rateBetween(s.net_tx_bytes, prev.net_tx_bytes, dtSeconds) : null;
    const blkR = canRate ? rateBetween(s.blk_read_bytes, prev.blk_read_bytes, dtSeconds) : null;
    const blkW = canRate ? rateBetween(s.blk_write_bytes, prev.blk_write_bytes, dtSeconds) : null;

    if (cpuPercent !== null) {
      cpuSum += cpuPercent;
      cpuCount += 1;
      cpuMax = cpuMax === null ? cpuPercent : Math.max(cpuMax, cpuPercent);
    }
    if (running && s.mem_bytes !== null) {
      memMax = memMax === null ? s.mem_bytes : Math.max(memMax, s.mem_bytes);
    }
    // Totals accumulate the positive byte deltas within same-container
    // segments — a window-wide "bytes in/out" that ignores reset jumps.
    if (canRate) {
      const dRx = (s.net_rx_bytes ?? 0) - (prev.net_rx_bytes ?? 0);
      const dTx = (s.net_tx_bytes ?? 0) - (prev.net_tx_bytes ?? 0);
      if (dRx > 0) rxTotal += dRx;
      if (dTx > 0) txTotal += dTx;
    }

    derived.push({
      sampled_at_ms: s.sampled_at_ms,
      status: s.status,
      cpu_percent: cpuPercent,
      mem_bytes: running ? s.mem_bytes : null,
      mem_percent: memPercent,
      net_rx_rate: netRx,
      net_tx_rate: netTx,
      blk_read_rate: blkR,
      blk_write_rate: blkW,
      pids: running ? s.pids : null,
    });
  }

  const eventCounts: Record<string, number> = {};
  for (const e of events) {
    eventCounts[e.action] = (eventCounts[e.action] ?? 0) + 1;
  }

  return {
    samples: derived,
    events,
    summary: {
      sample_count: samples.length,
      running_sample_count: samples.filter((s) => s.status === "running").length,
      cpu_percent_avg: cpuCount > 0 ? Math.round((cpuSum / cpuCount) * 100) / 100 : null,
      cpu_percent_max: cpuMax,
      mem_bytes_max: memMax,
      net_rx_bytes_total: rxTotal,
      net_tx_bytes_total: txTotal,
      event_counts: eventCounts,
      has_gap: gapPresent,
    },
  };
}

/** Fetch a project's stored samples + events in [fromMs, toMs] and derive the
 *  history answer. Returns null if the project doesn't exist. */
export function getProjectHistory(
  projectId: number,
  fromMs: number,
  toMs: number,
): ProjectHistory | null {
  const project = db.query("SELECT id FROM projects WHERE id = ?").get(projectId);
  if (!project) return null;

  const samples = db
    .query(
      `SELECT container_id, sampled_at_ms, status, cpu_total_ns, cpu_system_ns, online_cpus,
              mem_bytes, mem_limit_bytes, net_rx_bytes, net_tx_bytes,
              blk_read_bytes, blk_write_bytes, pids
       FROM project_resource_samples
       WHERE project_id = ? AND sampled_at_ms BETWEEN ? AND ?
       ORDER BY sampled_at_ms`,
    )
    .all(projectId, fromMs, toMs) as ResourceSampleRow[];

  const events = db
    .query(
      `SELECT occurred_at_ms, source, action, container_id, time_nano
       FROM project_events
       WHERE project_id = ? AND occurred_at_ms BETWEEN ? AND ?
       ORDER BY occurred_at_ms`,
    )
    .all(projectId, fromMs, toMs) as ProjectEventRow[];

  // Gap markers are host-wide (project_id NULL); surface whether any landed in
  // the window so the reader knows events may be incomplete.
  const gapRow = db
    .query(
      `SELECT COUNT(*) n FROM project_events
       WHERE project_id IS NULL AND action = 'docker_event_gap'
         AND occurred_at_ms BETWEEN ? AND ?`,
    )
    .get(fromMs, toMs) as { n: number };

  return deriveHistory(samples, events, gapRow.n > 0);
}
