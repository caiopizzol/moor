import { apiGet } from "../client";

type ServerStats = {
  hostname: string;
  os: string;
  uptime: string;
  cpu: { percent: number; cores: number };
  memory: { total: string; used: string; percent: number };
  disk: { total: string; used: string; percent: number };
  containers: { running: number; total: number };
};

export async function statsCommand() {
  const res = await apiGet("/api/server/stats");
  if (!res.ok) {
    console.error(`Failed to get stats: ${res.status}`);
    process.exit(1);
  }

  const s = (await res.json()) as ServerStats;

  console.log(`Host:        ${s.hostname}`);
  console.log(`OS:          ${s.os}`);
  console.log(`Uptime:      ${s.uptime}`);
  console.log(`CPU:         ${s.cpu.percent}% (${s.cpu.cores} cores)`);
  console.log(`Memory:      ${s.memory.used} / ${s.memory.total} (${s.memory.percent}%)`);
  console.log(`Disk:        ${s.disk.used} / ${s.disk.total} (${s.disk.percent}%)`);
  console.log(`Containers:  ${s.containers.running} running / ${s.containers.total} total`);
}
