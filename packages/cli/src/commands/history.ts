import type { ProjectHistory } from "../../../contract/src/index";
import { apiGet, findProject } from "../client";
import { requestProjects } from "../project-response";
import { type CommandOutput, defaultCommandOutput, requestJson, writeError } from "../protocol";

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const val = bytes / 1024 ** i;
  return `${val.toFixed(val < 10 ? 1 : 0)} ${units[i]}`;
}

export function parseHistoryArgs(args: string[]): {
  project?: string;
  hours: number;
  error?: string;
} {
  let project: string | undefined;
  let hours = 24;
  let seenHours = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--hours" || a.startsWith("--hours=")) {
      if (seenHours) return { hours, error: "--hours may be used only once" };
      seenHours = true;
    }
    if (a === "--hours") {
      const n = Number(args[++i]); // consume the next token as the value
      if (!Number.isFinite(n * 3_600_000) || n <= 0)
        return { hours, error: "--hours must be a positive number" };
      hours = n;
    } else if (a.startsWith("--hours=")) {
      const n = Number(a.slice("--hours=".length));
      if (!Number.isFinite(n * 3_600_000) || n <= 0)
        return { hours, error: "--hours must be a positive number" };
      hours = n;
    } else if (!a.startsWith("-") && project === undefined) {
      project = a;
    } else return { hours, error: `Unexpected argument: ${a}` };
  }
  if (!project) return { hours, error: "missing project" };
  return { project, hours };
}

const USAGE = "Usage: moor history <project> [--hours N] [--json]";

export async function historyCommand(
  args: string[],
  output: CommandOutput = defaultCommandOutput,
): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    output.stdout(`${USAGE}\n`);
    return 0;
  }
  const json = args.includes("--json");
  const parsed = parseHistoryArgs(args.filter((arg) => arg !== "--json"));
  if (parsed.error || !parsed.project) {
    writeError(output, parsed.error ?? "Project is required", json);
    return 1;
  }
  const projects = await requestProjects(json, output);
  if (!projects.ok) return 1;
  const project = findProject(projects.value, parsed.project);
  if (!project) {
    writeError(output, `Project "${parsed.project}" not found`, json);
    return 1;
  }
  const to = Date.now();
  const from = Math.max(0, to - parsed.hours * 3_600_000);
  const result = await requestJson<ProjectHistory>(
    () => apiGet(`/api/projects/${project.id}/stats/history?from=${from}&to=${to}`),
    json,
    "Failed to get history",
    output,
  );
  if (!result.ok) return 1;
  try {
    output.stdout(
      json ? `${JSON.stringify(result.value)}\n` : renderHistory(project.name, result.value),
    );
  } catch {
    writeError(output, "Invalid history response", json);
    return 1;
  }
  return 0;
}

function renderHistory(name: string, h: ProjectHistory): string {
  const lines: string[] = [];
  const s = h.summary;
  const windowH = Math.round(((h.to_ms - h.from_ms) / 3_600_000) * 10) / 10;

  lines.push(`${name} — history over ~${windowH}h`);
  if (s.has_gap) {
    lines.push("  \x1b[33m⚠ event gap recorded: events may be incomplete\x1b[0m");
  }
  lines.push(`  Samples:   ${s.sample_count} total, ${s.running_sample_count} running`);
  lines.push(
    `  CPU:       avg ${s.cpu_percent_avg ?? "n/a"}% / max ${s.cpu_percent_max ?? "n/a"}%`,
  );
  lines.push(`  Memory:    max ${s.mem_bytes_max !== null ? formatBytes(s.mem_bytes_max) : "n/a"}`);
  lines.push(
    `  Network:   in ${formatBytes(s.net_rx_bytes_total)} / out ${formatBytes(s.net_tx_bytes_total)}`,
  );
  const counts = Object.entries(s.event_counts);
  if (counts.length > 0) {
    lines.push(`  Events:    ${counts.map(([a, n]) => `${a} ${n}`).join(", ")}`);
  }

  const recent = h.events.slice(-10);
  if (recent.length > 0) {
    lines.push("\nRecent events:");
    for (const e of recent) {
      lines.push(`  ${new Date(e.occurred_at_ms).toISOString()}  ${e.action}  (${e.source})`);
    }
  }
  if (s.sample_count === 0 && h.events.length === 0) {
    lines.push("  (no stored history in this window)");
  }
  return `${lines.join("\n")}\n`;
}
