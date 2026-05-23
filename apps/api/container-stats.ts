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
  cpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
    online_cpus?: number;
  };
  precpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
  };
  memory_stats?: {
    usage?: number;
    limit?: number;
    // cgroup v2 names; cgroup v1 uses different keys but we treat both
    // permissively — whichever exists, subtract it from usage.
    stats?: { inactive_file?: number; cache?: number };
  };
  networks?: Record<string, { rx_bytes?: number; tx_bytes?: number }>;
  blkio_stats?: {
    io_service_bytes_recursive?: Array<{ op?: string; value?: number }> | null;
  };
  pids_stats?: { current?: number };
};

/** Compute container CPU as a percentage of the host across the
 *  (cpu_stats - precpu_stats) interval Docker took on its own.
 *
 *  Per Docker Engine API: percent = (cpu_delta / system_delta) * online_cpus * 100.
 *  When the daemon's prior sample is missing (system_delta <= 0), there's no
 *  delta to compute against — return 0 rather than a divide-by-zero.
 */
export function computeCpuPercent(payload: DockerStatsPayload): number {
  const cur = payload.cpu_stats ?? {};
  const pre = payload.precpu_stats ?? {};
  const cpuDelta = (cur.cpu_usage?.total_usage ?? 0) - (pre.cpu_usage?.total_usage ?? 0);
  const sysDelta = (cur.system_cpu_usage ?? 0) - (pre.system_cpu_usage ?? 0);
  const cpus = cur.online_cpus ?? 0;
  if (cpuDelta <= 0 || sysDelta <= 0 || cpus <= 0) return 0;
  const pct = (cpuDelta / sysDelta) * cpus * 100;
  return Math.round(pct * 100) / 100;
}

/** Return container memory accounting that matches `docker stats`:
 *  usage minus the page cache portion (inactive_file on cgroup v2,
 *  cache on cgroup v1). The raw `usage` includes cache and overstates
 *  what the process is really holding. */
export function computeMemory(payload: DockerStatsPayload): {
  bytes: number;
  limit_bytes: number;
  percent: number;
} {
  const m = payload.memory_stats ?? {};
  const usage = m.usage ?? 0;
  const limit = m.limit ?? 0;
  const cacheLike = m.stats?.inactive_file ?? m.stats?.cache ?? 0;
  const bytes = Math.max(0, usage - cacheLike);
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

/** Sum Read/Write bytes from blkio.io_service_bytes_recursive. On
 *  cgroup v2 hosts this array is sometimes empty even when there's
 *  real I/O (kernel doesn't always expose per-device counters); we
 *  surface 0 in that case rather than fabricating a number. */
export function sumBlockIo(payload: DockerStatsPayload): {
  read_bytes: number;
  write_bytes: number;
} {
  const entries = payload.blkio_stats?.io_service_bytes_recursive ?? [];
  let read = 0;
  let write = 0;
  for (const e of entries) {
    const v = e.value ?? 0;
    if (e.op === "Read") read += v;
    else if (e.op === "Write") write += v;
  }
  return { read_bytes: read, write_bytes: write };
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
