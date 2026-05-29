// Pure helpers for #52 per-project live stats. The Docker
// /containers/:id/stats?stream=false response is the source of truth;
// these helpers compute the derived numbers (CPU percent, network/block
// I/O totals, memory excluding cache) so the route is thin and tests
// don't need to mock the daemon.

export type StatsResponse = {
  running: true;
  cpu_percent: number;
  memory_bytes: number;
  memory_limit_bytes: number;
  memory_percent: number;
  network_rx_bytes: number;
  network_tx_bytes: number;
  block_read_bytes: number;
  block_write_bytes: number;
  pids: number;
};

export type NotRunningResponse = {
  running: false;
  cpu_percent: 0;
  memory_bytes: 0;
  memory_limit_bytes: 0;
  memory_percent: 0;
  network_rx_bytes: 0;
  network_tx_bytes: 0;
  block_read_bytes: 0;
  block_write_bytes: 0;
  pids: 0;
};

export type ContainerStatsResponse = StatsResponse | NotRunningResponse;

export const NOT_RUNNING: NotRunningResponse = {
  running: false,
  cpu_percent: 0,
  memory_bytes: 0,
  memory_limit_bytes: 0,
  memory_percent: 0,
  network_rx_bytes: 0,
  network_tx_bytes: 0,
  block_read_bytes: 0,
  block_write_bytes: 0,
  pids: 0,
};

export type DockerStatsPayload = {
  /** Docker stamps this with the wall-clock at which the stats sample was
   *  taken. For a stopped container, no sample is collected and the field
   *  is the Go zero-time `"0001-01-01T00:00:00Z"`. Most reliable signal
   *  the daemon gives us for "container exists but isn't running." */
  read?: string;
  cpu_stats?: {
    cpu_usage?: { total_usage?: number; percpu_usage?: number[] };
    // Docker returns `null` (not undefined) for this on a stopped container's
    // /stats response. Keep the type honest so `system_cpu_usage: null` test
    // fixtures match the real production shape.
    system_cpu_usage?: number | null;
    online_cpus?: number | null;
  };
  precpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number | null;
  };
  memory_stats?: {
    usage?: number;
    limit?: number;
    // cgroup v1 emits `total_inactive_file`; cgroup v2 emits `inactive_file`.
    // Matches Docker CLI's calculateMemUsageUnixNoCache.
    stats?: { total_inactive_file?: number; inactive_file?: number };
  };
  networks?: Record<string, { rx_bytes?: number; tx_bytes?: number }>;
  blkio_stats?: {
    io_service_bytes_recursive?: Array<{ op?: string; value?: number }> | null;
  };
  pids_stats?: { current?: number };
};

/** Detect that a `/containers/:id/stats?stream=false` payload describes a
 *  stopped container. Docker returns 200 (not 404) for an exited
 *  container that still exists, but with `read` set to the Go zero-time
 *  and `cpu_stats.system_cpu_usage` null. Either signal alone is enough;
 *  we check both for resilience against future daemon changes. */
export function isStoppedPayload(payload: DockerStatsPayload): boolean {
  if (payload.read === "0001-01-01T00:00:00Z") return true;
  if (payload.cpu_stats?.system_cpu_usage == null) return true;
  return false;
}

/** Compute container CPU as a percentage of the host across the
 *  (cpu_stats - precpu_stats) interval Docker took on its own.
 *
 *  Per Docker Engine API: percent = (cpu_delta / system_delta) * online_cpus * 100.
 *  When `online_cpus` is absent (older daemons), Docker CLI falls back to
 *  `len(cpu_usage.percpu_usage)` — we mirror that. When neither is present
 *  there's nothing to normalize against, return 0. Same for system_delta <= 0
 *  (no prior sample).
 */
export function computeCpuPercent(payload: DockerStatsPayload): number {
  const cur = payload.cpu_stats ?? {};
  const pre = payload.precpu_stats ?? {};
  const cpuDelta = (cur.cpu_usage?.total_usage ?? 0) - (pre.cpu_usage?.total_usage ?? 0);
  const sysDelta = (cur.system_cpu_usage ?? 0) - (pre.system_cpu_usage ?? 0);
  const cpus = cur.online_cpus ?? cur.cpu_usage?.percpu_usage?.length ?? 0;
  if (cpuDelta <= 0 || sysDelta <= 0 || cpus <= 0) return 0;
  const pct = (cpuDelta / sysDelta) * cpus * 100;
  return Math.round(pct * 100) / 100;
}

/** Return container memory accounting that matches `docker stats`'s
 *  calculateMemUsageUnixNoCache: subtract `total_inactive_file` (cgroup
 *  v1) or `inactive_file` (cgroup v2) from usage. Critically, only
 *  subtract when the inactive value is *less than* usage — otherwise
 *  fall through to raw usage. Docker CLI does the same (clamping to 0
 *  would silently misreport an active container as idle in the rare
 *  cgroup edges where the kernel reports inactive ≥ usage). */
export function computeMemory(payload: DockerStatsPayload): {
  bytes: number;
  limit_bytes: number;
  percent: number;
} {
  const m = payload.memory_stats ?? {};
  const usage = m.usage ?? 0;
  const limit = m.limit ?? 0;
  const v1 = m.stats?.total_inactive_file;
  const v2 = m.stats?.inactive_file;
  let bytes = usage;
  if (v1 !== undefined && v1 < usage) bytes = usage - v1;
  else if (v2 !== undefined && v2 < usage) bytes = usage - v2;
  const percent = limit > 0 ? Math.round((bytes / limit) * 10000) / 100 : 0;
  return { bytes, limit_bytes: limit, percent };
}

/** Sum rx/tx across every interface in `networks`. Containers using
 *  host networking have no `networks` field — return zeros rather than
 *  crash, matching how `docker stats` shows them. */
export function sumNetwork(payload: DockerStatsPayload): {
  rx_bytes: number;
  tx_bytes: number;
} {
  const nets = payload.networks ?? {};
  let rx = 0;
  let tx = 0;
  for (const iface of Object.values(nets)) {
    rx += iface.rx_bytes ?? 0;
    tx += iface.tx_bytes ?? 0;
  }
  return { rx_bytes: rx, tx_bytes: tx };
}

/** Sum Read/Write bytes from blkio.io_service_bytes_recursive. Docker
 *  CLI classifies entries by the first character case-insensitively
 *  ("Read"/"read"/"r"... → read), so we do the same — different daemon
 *  versions have used different casing. On cgroup v2 hosts the array
 *  is sometimes empty even when there's real I/O (kernel doesn't
 *  always expose per-device counters); we surface 0 in that case
 *  rather than fabricating a number. */
export function sumBlockIo(payload: DockerStatsPayload): {
  read_bytes: number;
  write_bytes: number;
} {
  const entries = payload.blkio_stats?.io_service_bytes_recursive ?? [];
  let read = 0;
  let write = 0;
  for (const e of entries) {
    const v = e.value ?? 0;
    const tag = (e.op ?? "")[0]?.toLowerCase();
    if (tag === "r") read += v;
    else if (tag === "w") write += v;
  }
  return { read_bytes: read, write_bytes: write };
}

/** Raw, cumulative counters extracted from a stats payload for persistence
 *  (#131). Unlike buildStatsResponse, which renders an instantaneous
 *  cpu_percent from Docker's ~1s precpu delta, this keeps the cumulative CPU
 *  counters so the history query can average CPU across the real inter-sample
 *  interval, and keeps network/block as cumulative totals so the query
 *  computes deltas/rates between consecutive samples. Memory is the same
 *  cache-excluded gauge the live route reports. */
export type RawCounterSample = {
  cpu_total_ns: number;
  cpu_system_ns: number;
  online_cpus: number;
  mem_bytes: number;
  mem_limit_bytes: number;
  net_rx_bytes: number;
  net_tx_bytes: number;
  blk_read_bytes: number;
  blk_write_bytes: number;
  pids: number;
};

export function extractRawSample(payload: DockerStatsPayload): RawCounterSample {
  const mem = computeMemory(payload);
  const net = sumNetwork(payload);
  const blk = sumBlockIo(payload);
  const cpu = payload.cpu_stats ?? {};
  return {
    cpu_total_ns: cpu.cpu_usage?.total_usage ?? 0,
    cpu_system_ns: cpu.system_cpu_usage ?? 0,
    online_cpus: cpu.online_cpus ?? cpu.cpu_usage?.percpu_usage?.length ?? 0,
    mem_bytes: mem.bytes,
    mem_limit_bytes: mem.limit_bytes,
    net_rx_bytes: net.rx_bytes,
    net_tx_bytes: net.tx_bytes,
    blk_read_bytes: blk.read_bytes,
    blk_write_bytes: blk.write_bytes,
    pids: payload.pids_stats?.current ?? 0,
  };
}

/** Compose the route's JSON response from a Docker stats payload. */
export function buildStatsResponse(payload: DockerStatsPayload): StatsResponse {
  const mem = computeMemory(payload);
  const net = sumNetwork(payload);
  const blk = sumBlockIo(payload);
  return {
    running: true,
    cpu_percent: computeCpuPercent(payload),
    memory_bytes: mem.bytes,
    memory_limit_bytes: mem.limit_bytes,
    memory_percent: mem.percent,
    network_rx_bytes: net.rx_bytes,
    network_tx_bytes: net.tx_bytes,
    block_read_bytes: blk.read_bytes,
    block_write_bytes: blk.write_bytes,
    pids: payload.pids_stats?.current ?? 0,
  };
}
