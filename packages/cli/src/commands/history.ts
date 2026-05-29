import { apiGet, resolveProject } from "../client";

type HistoryResponse = {
  from_ms: number;
  to_ms: number;
  events: Array<{ occurred_at_ms: number; source: string; action: string }>;
  summary: {
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
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const val = bytes / 1024 ** i;
  return `${val.toFixed(val < 10 ? 1 : 0)} ${units[i]}`;
}

// Stored resource history + lifecycle events for one project (not live — use
// `moor stats` for the host snapshot). Mirrors the moor_project_history MCP
// tool: a window summary plus recent events.
export async function historyCommand(args: string[]) {
  const projectName = args.find((a) => !a.startsWith("-"));
  if (!projectName) {
    console.error("Usage: moor history <project> [--hours N]");
    process.exit(1);
  }
  const hoursIdx = args.indexOf("--hours");
  const hours = hoursIdx >= 0 ? Number(args[hoursIdx + 1]) : 24;
  if (!Number.isFinite(hours) || hours <= 0) {
    console.error("--hours must be a positive number");
    process.exit(1);
  }

  const project = await resolveProject(projectName);
  const to = Date.now();
  const from = to - hours * 3_600_000;
  const res = await apiGet(`/api/projects/${project.id}/stats/history?from=${from}&to=${to}`);
  if (!res.ok) {
    console.error(`Failed to get history: ${res.status} ${await res.text()}`);
    process.exit(1);
  }

  const h = (await res.json()) as HistoryResponse;
  const s = h.summary;
  const windowH = Math.round(((h.to_ms - h.from_ms) / 3_600_000) * 10) / 10;

  console.log(`${project.name} — history over ~${windowH}h`);
  if (s.has_gap) {
    console.log("  \x1b[33m⚠ event gap recorded: events may be incomplete\x1b[0m");
  }
  console.log(`  Samples:   ${s.sample_count} total, ${s.running_sample_count} running`);
  console.log(
    `  CPU:       avg ${s.cpu_percent_avg ?? "n/a"}% / max ${s.cpu_percent_max ?? "n/a"}%`,
  );
  console.log(
    `  Memory:    max ${s.mem_bytes_max !== null ? formatBytes(s.mem_bytes_max) : "n/a"}`,
  );
  console.log(
    `  Network:   in ${formatBytes(s.net_rx_bytes_total)} / out ${formatBytes(s.net_tx_bytes_total)}`,
  );
  const counts = Object.entries(s.event_counts);
  if (counts.length > 0) {
    console.log(`  Events:    ${counts.map(([a, n]) => `${a} ${n}`).join(", ")}`);
  }

  const recent = h.events.slice(-10);
  if (recent.length > 0) {
    console.log("\nRecent events:");
    for (const e of recent) {
      console.log(`  ${new Date(e.occurred_at_ms).toISOString()}  ${e.action}  (${e.source})`);
    }
  }
  if (s.sample_count === 0 && h.events.length === 0) {
    console.log("  (no stored history in this window)");
  }
}
