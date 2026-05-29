import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { SOCKET as SOCKET_PATH } from "../docker";
import {
  computeLoadPercent,
  type DockerDisk,
  type LoadInfo,
  parseLoadAvg,
  parseProcMeminfo,
  parseProcUptime,
  parseSystemDf,
  type SystemDfResponse,
} from "../server-stats";

function tryReadProc(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

export async function handleServer(_req: Request, url: URL): Promise<Response | null> {
  if (url.pathname === "/api/server/stats" && _req.method === "GET") {
    return handleStats();
  }
  // #78
  if (url.pathname === "/api/server/update-status" && _req.method === "GET") {
    return handleUpdateStatus();
  }
  // #79
  if (url.pathname === "/api/server/drain" && _req.method === "GET") {
    return handleDrainStatus();
  }
  if (url.pathname === "/api/server/drain/enable" && _req.method === "POST") {
    return handleDrainEnable(_req);
  }
  if (url.pathname === "/api/server/drain/disable" && _req.method === "POST") {
    return handleDrainDisable();
  }
  // #90
  if (url.pathname === "/api/server/backup" && _req.method === "POST") {
    return handleDbBackup();
  }
  // #80 PR #4
  if (url.pathname === "/api/server/update/apply" && _req.method === "POST") {
    return handleUpdateApply(_req);
  }
  // #80 PR #6
  if (url.pathname === "/api/server/update/audit" && _req.method === "GET") {
    return handleUpdateAudit(url);
  }
  return null;
}

async function handleUpdateAudit(url: URL): Promise<Response> {
  const { listAudit } = await import("../update-audit");
  const limitRaw = url.searchParams.get("limit");
  let limit = 20;
  if (limitRaw !== null) {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n < 1 || n > 200) {
      return Response.json({ error: "limit must be an integer in [1, 200]" }, { status: 400 });
    }
    limit = n;
  }
  return Response.json({ rows: listAudit(limit) });
}

async function handleUpdateApply(req: Request): Promise<Response> {
  const { applyUpdate } = await import("../update-apply");
  const body = (await req.json().catch(() => ({}))) as {
    target_digest?: string;
    bypass?: ("active_work" | "unknown_digest")[];
  };
  const result = await applyUpdate(body);
  if (result.ok) {
    return Response.json({ audit_id: result.audit_id }, { status: 202 });
  }
  // Map error codes → HTTP status. Preflight refusals and races are 409
  // (request was understood but state conflicts); context_failed is 412
  // (precondition labels missing); current_image_unknown is 503 (Docker
  // unreachable); backup/launch failures are 500 (moor-side I/O).
  const statusByCode: Record<typeof result.error.code, number> = {
    preflight_failed: 409,
    context_failed: 412,
    current_image_unknown: 503,
    already_in_progress: 409,
    race_active_work: 409,
    backup_failed: 500,
    respawner_launch_failed: 500,
  };
  return Response.json({ error: result.error }, { status: statusByCode[result.error.code] });
}

async function handleDbBackup(): Promise<Response> {
  const { DEFAULT_KEEP_BACKUPS, defaultBackupDir, runBackup } = await import("../db-backup");
  try {
    const dir = defaultBackupDir();
    const result = runBackup({ dir, keep: DEFAULT_KEEP_BACKUPS });
    return Response.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return Response.json({ error: msg }, { status: 500 });
  }
}

async function handleUpdateStatus(): Promise<Response> {
  const { buildUpdateStatus } = await import("../update-status");
  try {
    return Response.json(await buildUpdateStatus());
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return Response.json({ error: msg }, { status: 500 });
  }
}

async function handleDrainStatus(): Promise<Response> {
  const { getDrainState } = await import("../drain");
  const { getActiveWorkCounts } = await import("../update-status");
  // active_work uses the same counter as update-status so the two
  // tools never disagree about what's in flight.
  return Response.json({
    state: getDrainState(),
    active_work: getActiveWorkCounts(),
  });
}

async function handleDrainEnable(req: Request): Promise<Response> {
  const { enableDrain } = await import("../drain");
  const body = (await req.json().catch(() => ({}))) as {
    reason?: string;
    ttl_minutes?: number;
    clear_after_version?: string;
  };
  const state = enableDrain(body);
  return Response.json({ state });
}

async function handleDrainDisable(): Promise<Response> {
  const { disableDrain, getDrainState } = await import("../drain");
  disableDrain();
  return Response.json({ state: getDrainState() });
}

async function handleStats(): Promise<Response> {
  try {
    const stats = await getServerStats();
    return Response.json(stats);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return Response.json({ error: msg }, { status: 500 });
  }
}

export async function getServerStats() {
  const hostname = tryExec("hostname") || "unknown";
  const os = getOsInfo();
  const uptime = getUptime();
  const cpu = getCpuUsage();
  const load = getLoadInfo(cpu.cores);
  const memory = getMemoryInfo();
  const disk = getDiskInfo();
  const [containers, docker] = await Promise.all([getContainerInfo(), getDockerDiskInfo()]);
  const disks = getAllDisks();

  return { hostname, os, uptime, cpu, load, memory, disk, disks, containers, docker };
}

function getLoadInfo(cores: number): LoadInfo {
  const raw = tryExec("cat /proc/loadavg 2>/dev/null");
  if (!raw) return { one_min: 0, cores, normalized_percent: 0 };
  const one_min = parseLoadAvg(raw);
  if (!Number.isFinite(one_min)) return { one_min: 0, cores, normalized_percent: 0 };
  return { one_min, cores, normalized_percent: computeLoadPercent(one_min, cores) };
}

async function getDockerDiskInfo(): Promise<DockerDisk | null> {
  try {
    const res = await fetch("http://localhost/v1.44/system/df", {
      unix: SOCKET_PATH,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return parseSystemDf((await res.json()) as SystemDfResponse);
  } catch {
    return null;
  }
}

function tryExec(cmd: string): string {
  try {
    return execSync(cmd, { timeout: 5000, encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
}

function getOsInfo(): string {
  const name = tryExec("uname -s");
  const release = tryExec("uname -r");
  const pretty = tryExec("cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d'\"' -f2");
  return pretty || `${name} ${release}`;
}

function getUptime(): string {
  // The production image (oven/bun:1-slim) does not ship `uptime`. Read
  // /proc/uptime directly; only fall back to the shell for macOS dev.
  const proc = tryReadProc("/proc/uptime");
  if (proc) {
    const formatted = parseProcUptime(proc);
    if (formatted) return formatted;
  }
  const raw = tryExec("uptime -p 2>/dev/null || uptime");
  const match = raw.match(/up\s+(.+)/);
  return match ? match[1].replace(/,\s*$/, "").trim() : raw;
}

function getCpuUsage(): { percent: number; cores: number } {
  const cores = Number(tryExec("nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null")) || 1;

  const loadAvg = tryExec("cat /proc/loadavg 2>/dev/null");
  if (loadAvg) {
    const load1m = Number.parseFloat(loadAvg.split(" ")[0]);
    const percent = Math.min(100, Math.round((load1m / cores) * 100));
    return { percent, cores };
  }

  // macOS fallback
  const topOut = tryExec("top -l 1 -n 0 2>/dev/null | grep 'CPU usage'");
  const cpuMatch = topOut.match(/([\d.]+)%\s*user/);
  const percent = cpuMatch ? Math.round(Number.parseFloat(cpuMatch[1])) : 0;
  return { percent, cores };
}

function getMemoryInfo(): { total: string; used: string; percent: number } {
  // The production image (oven/bun:1-slim) does not ship `free`. Read
  // /proc/meminfo directly; only fall back to macOS sysctl/vm_stat for dev.
  const proc = tryReadProc("/proc/meminfo");
  if (proc) {
    const parsed = parseProcMeminfo(proc);
    if (parsed) {
      return {
        total: formatBytes(parsed.totalBytes),
        used: formatBytes(parsed.usedBytes),
        percent: parsed.percent,
      };
    }
  }

  // macOS fallback (dev only)
  const totalRaw = tryExec("sysctl -n hw.memsize 2>/dev/null");
  const total = Number(totalRaw) || 0;
  const vmStat = tryExec("vm_stat 2>/dev/null");
  const pageSize = 16384;
  const activeMatch = vmStat.match(/Pages active:\s+(\d+)/);
  const wiredMatch = vmStat.match(/Pages wired down:\s+(\d+)/);
  const compressedMatch = vmStat.match(/Pages occupied by compressor:\s+(\d+)/);
  const used =
    ((Number(activeMatch?.[1]) || 0) +
      (Number(wiredMatch?.[1]) || 0) +
      (Number(compressedMatch?.[1]) || 0)) *
    pageSize;

  return {
    total: formatBytes(total),
    used: formatBytes(used),
    percent: total > 0 ? Math.round((used / total) * 100) : 0,
  };
}

function getDiskInfo(): { total: string; used: string; percent: number } {
  const dfOut = tryExec("df -B1 / 2>/dev/null | tail -1") || tryExec("df -k / | tail -1");
  const parts = dfOut.split(/\s+/);

  if (parts.length >= 5) {
    const total = Number(parts[1]);
    const used = Number(parts[2]);
    const percentStr = parts[4]?.replace("%", "");

    if (total > 1000000) {
      return {
        total: formatBytes(total),
        used: formatBytes(used),
        percent: Number(percentStr) || Math.round((used / total) * 100),
      };
    }

    return {
      total: formatBytes(total * 1024),
      used: formatBytes(used * 1024),
      percent: Number(percentStr) || 0,
    };
  }

  return { total: "?", used: "?", percent: 0 };
}

// #137: the single-root `disk` above hides additional mounted volumes (e.g. a
// separate data disk holding project databases that can be near-full while
// root looks empty). Report every real filesystem instead.
export type DiskFs = {
  mount: string;
  total: string;
  used: string;
  percent: number;
  label?: string;
};

// #140: moor runs in a container, so the df-derived list above only sees
// filesystems mounted INTO the container — it can't see a host data volume
// that isn't bind-mounted in. MOOR_MONITORED_DISKS lets an operator bind-mount
// specific host paths read-only and have moor report them with friendly
// labels. Format: comma-separated `containerPath` entries, each optionally
// `|label` (e.g. `/host/mnt/volume-hil-1|CNPJ data`).
export type MonitoredDiskConfig = { path: string; label: string };

export function parseMonitoredDisks(raw: string | undefined): MonitoredDiskConfig[] {
  if (!raw) return [];
  const out: MonitoredDiskConfig[] = [];
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const bar = trimmed.indexOf("|");
    const path = (bar >= 0 ? trimmed.slice(0, bar) : trimmed).trim();
    const label = (bar >= 0 ? trimmed.slice(bar + 1).trim() : "") || path;
    if (path) out.push({ path, label });
  }
  return out;
}

/** Pure: parse a `df -B1 --output=size,used,pcent <path>` body into totals.
 *  Returns null when the path isn't a mounted filesystem (df failed / empty). */
export function parseDfOne(raw: string): { total: number; used: number; percent: number } | null {
  for (const line of raw.trim().split("\n")) {
    const p = line.trim().split(/\s+/);
    const total = Number(p[0]);
    const used = Number(p[1]);
    const pct = Number((p[2] ?? "").replace("%", ""));
    if (Number.isFinite(total) && total > 0) {
      return {
        total,
        used,
        percent: Number.isFinite(pct) && pct > 0 ? pct : Math.round((used / total) * 100),
      };
    }
  }
  return null;
}

/** A monitored path reaches a shell, so require an absolute path of plain
 *  characters. This blocks injection AND option-shaped values like `-h` (which
 *  df would treat as a flag). The `--` in the df command is a second guard. */
export function isSafeMonitoredPath(path: string): boolean {
  return path.startsWith("/") && /^[A-Za-z0-9_./-]+$/.test(path);
}

function getMonitoredDisks(): DiskFs[] {
  const out: DiskFs[] = [];
  for (const cfg of parseMonitoredDisks(process.env.MOOR_MONITORED_DISKS)) {
    if (!isSafeMonitoredPath(cfg.path)) continue;
    const raw = tryExec(`df -B1 --output=size,used,pcent -- ${cfg.path} 2>/dev/null`);
    const d = raw ? parseDfOne(raw) : null;
    if (!d) continue; // not mounted into the container — skip rather than show a phantom
    out.push({
      mount: cfg.path,
      label: cfg.label,
      total: formatBytes(d.total),
      used: formatBytes(d.used),
      percent: d.percent,
    });
  }
  return out;
}

/** Pure: parse `df -B1 --output=source,size,used,pcent,target` into real
 *  filesystems. Skips pseudo filesystems (tmpfs/overlay/devtmpfs — their
 *  source isn't a /dev/ node) and the boot partition. */
export function parseDiskList(raw: string): DiskFs[] {
  const out: DiskFs[] = [];
  for (const line of raw.trim().split("\n")) {
    const p = line.trim().split(/\s+/);
    if (p.length < 5) continue;
    const source = p[0];
    if (!source.startsWith("/dev/")) continue; // drops header + tmpfs/overlay/etc.
    const total = Number(p[1]);
    const used = Number(p[2]);
    const pct = Number((p[3] ?? "").replace("%", ""));
    const mount = p.slice(4).join(" ");
    if (mount.startsWith("/boot")) continue;
    if (!Number.isFinite(total) || total <= 0) continue;
    out.push({
      mount,
      total: formatBytes(total),
      used: formatBytes(used),
      percent: Number.isFinite(pct) && pct > 0 ? pct : Math.round((used / total) * 100),
    });
  }
  return out;
}

function getAllDisks(): DiskFs[] {
  const raw = tryExec("df -B1 --output=source,size,used,pcent,target 2>/dev/null");
  const visible = raw ? parseDiskList(raw) : [];
  // df --output unsupported (older coreutils / non-Linux dev host): fall back
  // to the root-only figure so the card still shows something.
  const base = visible.length > 0 ? visible : [{ mount: "/", ...getDiskInfo() } satisfies DiskFs];
  // Append operator-configured host volumes (#140) that the container can't
  // otherwise see.
  return [...base, ...getMonitoredDisks()];
}

async function getContainerInfo(): Promise<{ running: number; total: number }> {
  try {
    const [allRes, runningRes] = await Promise.all([
      fetch("http://localhost/v1.44/containers/json?all=true", {
        unix: SOCKET_PATH,
        signal: AbortSignal.timeout(5000),
      }),
      fetch("http://localhost/v1.44/containers/json", {
        unix: SOCKET_PATH,
        signal: AbortSignal.timeout(5000),
      }),
    ]);
    const all = allRes.ok ? ((await allRes.json()) as unknown[]) : [];
    const running = runningRes.ok ? ((await runningRes.json()) as unknown[]) : [];
    return { running: running.length, total: all.length };
  } catch {
    return { running: 0, total: 0 };
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / 1024 ** i;
  return `${val.toFixed(val < 10 ? 1 : 0)} ${units[i]}`;
}
