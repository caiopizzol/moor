import type { ServerStats } from "../../../contract/src/index";
import { apiGet } from "../client";
import { type CommandOutput, defaultCommandOutput, requestJson, writeError } from "../protocol";

export async function statsCommand(
  args: string[] = [],
  output: CommandOutput = defaultCommandOutput,
): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    output.stdout("Usage: moor stats [--json]\n");
    return 0;
  }
  const json = args.includes("--json");
  const unknown = args.find((arg) => arg !== "--json");
  if (unknown !== undefined) {
    writeError(output, `Unexpected argument: ${unknown}`, json);
    return 1;
  }
  const result = await requestJson<ServerStats>(
    () => apiGet("/api/server/stats"),
    json,
    "Failed to get stats",
    output,
  );
  if (!result.ok) return 1;
  try {
    output.stdout(json ? `${JSON.stringify(result.value)}\n` : renderStats(result.value));
  } catch {
    writeError(output, "Invalid stats response", json);
    return 1;
  }
  return 0;
}

function renderStats(s: ServerStats): string {
  const lines = [
    `Host:        ${s.hostname}`,
    `OS:          ${s.os}`,
    `Uptime:      ${s.uptime}`,
    `CPU:         ${s.cpu.percent}% (${s.cpu.cores} cores)`,
    `Memory:      ${s.memory.used} / ${s.memory.total} (${s.memory.percent}%)`,
  ];
  const disks = s.disks?.length ? s.disks : [{ mount: "/", ...s.disk }];
  disks.forEach((d, i) => {
    const prefix = i === 0 ? "Disk:" : "     ";
    const name = d.label ? `${d.label} (${d.mount})` : d.mount;
    lines.push(`${prefix}        ${name}  ${d.used} / ${d.total} (${d.percent}%)`);
  });
  lines.push(`Containers:  ${s.containers.running} running / ${s.containers.total} total`);
  return `${lines.join("\n")}\n`;
}
