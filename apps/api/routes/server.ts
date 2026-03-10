import { execSync } from "node:child_process";
import { SOCKET as SOCKET_PATH } from "../docker";

export function handleServer(_req: Request, url: URL): Response | null {
  if (url.pathname !== "/api/server/stats" || _req.method !== "GET") return null;

  try {
    const stats = getServerStats();
    return Response.json(stats);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return Response.json({ error: msg }, { status: 500 });
  }
}

function getServerStats() {
  const hostname = tryExec("hostname") || "unknown";
  const os = getOsInfo();
  const uptime = getUptime();
  const cpu = getCpuUsage();
  const memory = getMemoryInfo();
  const disk = getDiskInfo();
  const containers = getContainerInfo();

  return { hostname, os, uptime, cpu, memory, disk, containers };
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
  // Try to get distro name on Linux
  const pretty = tryExec("cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d'\"' -f2");
  return pretty || `${name} ${release}`;
}

function getUptime(): string {
  const raw = tryExec("uptime -p 2>/dev/null || uptime");
  // Clean up "up X days, Y hours" style output
  const match = raw.match(/up\s+(.+)/);
  return match ? match[1].replace(/,\s*$/, "").trim() : raw;
}

function getCpuUsage(): { percent: number; cores: number } {
  const cores = Number(tryExec("nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null")) || 1;

  // Try Linux /proc/stat first, fallback to top
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
  // Try Linux free command
  const freeOut = tryExec("free -b 2>/dev/null | grep Mem");
  if (freeOut) {
    const parts = freeOut.split(/\s+/);
    const total = Number(parts[1]);
    const used = Number(parts[2]);
    return {
      total: formatBytes(total),
      used: formatBytes(used),
      percent: Math.round((used / total) * 100),
    };
  }

  // macOS fallback
  const totalRaw = tryExec("sysctl -n hw.memsize 2>/dev/null");
  const total = Number(totalRaw) || 0;
  const vmStat = tryExec("vm_stat 2>/dev/null");
  const pageSize = 16384; // common on Apple Silicon
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

  // Linux df -B1 output: Filesystem 1B-blocks Used Available Use% Mount
  if (parts.length >= 5) {
    const total = Number(parts[1]);
    const used = Number(parts[2]);
    const percentStr = parts[4]?.replace("%", "");

    if (total > 1000000) {
      // Looks like byte values (df -B1)
      return {
        total: formatBytes(total),
        used: formatBytes(used),
        percent: Number(percentStr) || Math.round((used / total) * 100),
      };
    }

    // Fallback: df -k (kilobytes)
    return {
      total: formatBytes(total * 1024),
      used: formatBytes(used * 1024),
      percent: Number(percentStr) || 0,
    };
  }

  return { total: "?", used: "?", percent: 0 };
}

function getContainerInfo(): { running: number; total: number } {
  try {
    const allOut = tryExec(
      `curl -s --unix-socket ${SOCKET_PATH} http://localhost/v1.44/containers/json?all=true 2>/dev/null`,
    );
    const all = allOut ? JSON.parse(allOut) : [];
    const runningOut = tryExec(
      `curl -s --unix-socket ${SOCKET_PATH} http://localhost/v1.44/containers/json 2>/dev/null`,
    );
    const running = runningOut ? JSON.parse(runningOut) : [];
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
