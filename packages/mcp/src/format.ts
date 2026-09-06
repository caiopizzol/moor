import { tailUtf8 } from "./tail-utf8";

export type DrainState = {
  enabled: boolean;
  reason: string | null;
  started_at: string | null;
  expires_at: string | null;
  clear_after_version: string | null;
};

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const val = bytes / 1024 ** i;
  return `${val.toFixed(val < 10 ? 1 : 0)} ${units[i]}`;
}

export function renderDrainState(s: DrainState): string[] {
  if (!s.enabled) return ["drain: OFF"];
  const lines = [`drain: ON (reason: ${s.reason ?? "(none)"})`];
  if (s.started_at) lines.push(`  started_at:  ${s.started_at}`);
  if (s.expires_at) lines.push(`  expires_at:  ${s.expires_at} (auto-clear)`);
  if (s.clear_after_version) {
    lines.push(
      `  clear_after_version: ${s.clear_after_version} (auto-clear on matching boot version)`,
    );
  }
  return lines;
}

export function deriveRunStatus(row: {
  finished_at: string | null;
  exit_code: number | null;
}): "running" | "success" | "failed" {
  if (!row.finished_at) return "running";
  return row.exit_code === 0 ? "success" : "failed";
}

// A runs row can be a cron run, a build/manual run, OR a cron run whose cron
// was deleted (cron_id was SET NULL by the FK). The list alone can't tell the
// latter two apart, so labels are honest about ambiguity instead of confidently
// calling NULL cron_id "build."
export function deriveRunType(row: { cron_id: number | null; cron_name: string | null }): string {
  if (row.cron_name) return `cron(${row.cron_name})`;
  // cron_id IS NULL — could be a genuine build/manual run, or a cron run
  // whose cron has since been deleted (ON DELETE SET NULL on the FK).
  return "build_or_manual";
}

export function formatMsShort(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${s % 60}s`;
}

export function appendStream(
  lines: string[],
  name: string,
  raw: string,
  totalBytes: number,
  cap: number,
): void {
  if (!raw && totalBytes === 0) return;
  if (!raw) {
    // API returned an empty string but the stream did emit data (totalBytes > 0
    // is possible when no bytes survived API-side tail cap, though unlikely).
    lines.push(`${name}_total_bytes=${totalBytes}`);
    return;
  }
  const { tail, storedBytes, trimmed: mcpTrimmed } = tailUtf8(raw, cap);
  const apiTrimmed = totalBytes > storedBytes;
  let header: string;
  if (mcpTrimmed && apiTrimmed) {
    header = `${name} (showing last ${tail.length} chars of ${storedBytes} stored bytes; ${totalBytes} total bytes seen):`;
  } else if (mcpTrimmed) {
    header = `${name} (showing last ${tail.length} chars of ${storedBytes} total bytes):`;
  } else if (apiTrimmed) {
    header = `${name} (tail of ${storedBytes} stored from ${totalBytes} total bytes seen):`;
  } else {
    header = `${name}:`;
  }
  lines.push(header);
  if (cap > 0) lines.push(tail);
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h${rm}m${rs}s`;
}
