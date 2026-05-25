// #80 PR #6: pure renderers for moor_update_audit. Lives next to its
// consumer (the MCP tool) so the formatting that operators actually
// see has direct test coverage.
//
// Each row renders as a multi-line block with id, state, duration,
// digest deltas, prev_image_id, backup path, and per-field tailed
// error_log / rollback_error.

/** API row shape returned by GET /api/server/update/audit. Subset of
 *  the full DB row — only what the renderer needs. */
export type UpdateAuditApiRow = {
  id: number;
  state: string;
  started_at: string;
  duration_ms: number | null;
  from_digest: string | null;
  to_digest: string | null;
  prev_image_id: string | null;
  backup_path: string | null;
  error_log: string | null;
  rollback_error: string | null;
};

export const DEFAULT_LOG_TAIL_BYTES = 4096;
export const MAX_LOG_TAIL_BYTES = 16384;

/** Pure: short-form a sha256 digest for compact rendering (first 7 +
 *  last 7). Accepts both raw `sha256:<hex>` and `repo@sha256:<hex>`
 *  forms; returns the input unchanged on anything else. */
export function shortDigest(s: string | null | undefined): string {
  if (!s) return "(none)";
  const m = s.match(/^(?:[^@]+@)?sha256:([0-9a-f]{64})$/);
  if (!m) return s;
  const hex = m[1];
  return `sha256:${hex.slice(0, 7)}…${hex.slice(-7)}`;
}

/** Pure: human-readable duration. Mirrors the format moor_runs uses. */
export function fmtDuration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m${rem}s`;
}

/** Pure: tail-truncate a string to maxBytes with a visible marker.
 *  maxBytes=0 means omit the field body entirely (returns the marker
 *  alone). Used per-field for error_log + rollback_error so a
 *  crashed update with a long log doesn't blow up the token budget. */
export function tailLog(s: string | null | undefined, maxBytes: number): string {
  if (s == null) return "";
  if (maxBytes <= 0) {
    const enc = new TextEncoder();
    return `[...${enc.encode(s).length} bytes elided (tail_bytes=0)]`;
  }
  const enc = new TextEncoder();
  const bytes = enc.encode(s);
  if (bytes.length <= maxBytes) return s;
  const dropped = bytes.length - maxBytes;
  const tail = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(dropped));
  return `[...${dropped} earlier bytes truncated]\n${tail}`;
}

/** Pure: render one audit row. tail_bytes applies separately to
 *  error_log and rollback_error; absent fields are skipped. */
export function renderAuditRow(row: UpdateAuditApiRow, opts: { tail_bytes?: number } = {}): string {
  const tail = Math.min(opts.tail_bytes ?? DEFAULT_LOG_TAIL_BYTES, MAX_LOG_TAIL_BYTES);
  const lines: string[] = [
    `audit_id=${row.id} state=${row.state} duration=${fmtDuration(row.duration_ms)} started=${row.started_at}`,
    `  from: ${shortDigest(row.from_digest)} → to: ${shortDigest(row.to_digest)}`,
  ];
  if (row.prev_image_id) lines.push(`  prev_image_id: ${shortDigest(row.prev_image_id)}`);
  if (row.backup_path) lines.push(`  backup: ${row.backup_path}`);
  if (row.error_log) lines.push(`  error_log: ${tailLog(row.error_log, tail)}`);
  if (row.rollback_error) {
    lines.push(`  rollback_error: ${tailLog(row.rollback_error, tail)}`);
  }
  return lines.join("\n");
}

/** Pure: render a list of rows separated by a blank line. Empty list
 *  returns the documented "no updates yet" string. */
export function renderAuditList(
  rows: UpdateAuditApiRow[],
  opts: { tail_bytes?: number } = {},
): string {
  if (rows.length === 0) {
    return "no update attempts recorded yet. Run moor_update_apply to start one.";
  }
  return rows.map((r) => renderAuditRow(r, opts)).join("\n\n");
}
