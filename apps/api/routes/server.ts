import { execSync } from "node:child_process";
import { SOCKET as SOCKET_PATH } from "../docker";

export async function handleServer(_req: Request, url: URL): Promise<Response | null> {
  if (url.pathname === "/api/server/stats" && _req.method === "GET") {
    return handleStats();
  }
  return null;
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

async function getServerStats() {
  const hostname = tryExec("hostname") || "unknown";
  const os = getOsInfo();
  const uptime = getUptime();
  const cpu = getCpuUsage();
  const memory = getMemoryInfo();
  const disk = getDiskInfo();
  const containers = await getContainerInfo();

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
  const pretty = tryExec("cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d'\"' -f2");
  return pretty || `${name} ${release}`;
}

function getUptime(): string {
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
