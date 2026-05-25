// Tests for the moor_update_audit renderer. Pure functions — no
// network, no DB. Lives next to its consumer so the formatting
// operators actually see has direct test coverage.

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_LOG_TAIL_BYTES,
  fmtDuration,
  MAX_LOG_TAIL_BYTES,
  renderAuditList,
  renderAuditRow,
  shortDigest,
  tailLog,
  type UpdateAuditApiRow,
} from "./update-audit-render";

function row(overrides: Partial<UpdateAuditApiRow> = {}): UpdateAuditApiRow {
  return {
    id: 1,
    state: "success",
    started_at: "2026-05-25 00:00:00",
    duration_ms: 50_000,
    from_digest: `sha256:${"a".repeat(64)}`,
    to_digest: `sha256:${"b".repeat(64)}`,
    prev_image_id: `sha256:${"c".repeat(64)}`,
    backup_path: "/app/data/moor.db.backup-1",
    error_log: null,
    rollback_error: null,
    ...overrides,
  };
}

describe("shortDigest", () => {
  test("formats sha256:<64 hex> as sha256:<7>…<7>", () => {
    expect(shortDigest(`sha256:${"a".repeat(64)}`)).toBe(
      `sha256:${"a".repeat(7)}…${"a".repeat(7)}`,
    );
  });
  test("strips the repo prefix from repo@sha256:... form", () => {
    expect(shortDigest(`ghcr.io/caiopizzol/moor@sha256:${"b".repeat(64)}`)).toBe(
      `sha256:${"b".repeat(7)}…${"b".repeat(7)}`,
    );
  });
  test("non-digest input passes through unchanged", () => {
    expect(shortDigest("sha256:short")).toBe("sha256:short");
    expect(shortDigest("not-a-digest")).toBe("not-a-digest");
  });
  test("null/undefined → '(none)'", () => {
    expect(shortDigest(null)).toBe("(none)");
    expect(shortDigest(undefined)).toBe("(none)");
  });
});

describe("fmtDuration", () => {
  test("null → em dash", () => expect(fmtDuration(null)).toBe("—"));
  test("sub-second values in ms", () => expect(fmtDuration(420)).toBe("420ms"));
  test("seconds for [1s, 60s)", () => expect(fmtDuration(50_000)).toBe("50s"));
  test("minutes+seconds at and above 60s", () => {
    expect(fmtDuration(60_000)).toBe("1m0s");
    expect(fmtDuration(125_000)).toBe("2m5s");
  });
});

describe("tailLog", () => {
  test("null/undefined → '' (no field rendered by caller)", () => {
    expect(tailLog(null, 100)).toBe("");
    expect(tailLog(undefined, 100)).toBe("");
  });
  test("short string passes through unchanged", () => {
    expect(tailLog("short", 100)).toBe("short");
  });
  test("long string is tail-truncated with a visible marker", () => {
    const big = "x".repeat(10_000);
    const out = tailLog(big, 1000);
    expect(out).toContain("[...9000 earlier bytes truncated]");
    expect(out.endsWith("x".repeat(1000))).toBe(true);
  });
  test("tail_bytes=0 elides the field body entirely with a sized marker", () => {
    const out = tailLog("hello world", 0);
    expect(out).toBe("[...11 bytes elided (tail_bytes=0)]");
  });
  test("tail_bytes=0 on null/undefined → ''", () => {
    expect(tailLog(null, 0)).toBe("");
    expect(tailLog(undefined, 0)).toBe("");
  });
});

describe("renderAuditRow", () => {
  test("success: includes id, state, duration, from/to, backup; no error_log line", () => {
    const out = renderAuditRow(row());
    expect(out).toContain("audit_id=1");
    expect(out).toContain("state=success");
    expect(out).toContain("duration=50s");
    expect(out).toContain("from: sha256:aaaaaaa");
    expect(out).toContain("to: sha256:bbbbbbb");
    expect(out).toContain("prev_image_id: sha256:ccccccc");
    expect(out).toContain("backup: /app/data/moor.db.backup-1");
    expect(out).not.toContain("error_log");
    expect(out).not.toContain("rollback_error");
  });

  test("rolled_back: error_log shown, rollback_error omitted", () => {
    const out = renderAuditRow(row({ state: "rolled_back", error_log: "health check failed" }));
    expect(out).toContain("state=rolled_back");
    expect(out).toContain("error_log: health check failed");
    expect(out).not.toContain("rollback_error");
  });

  test("rollback_failed: BOTH error_log and rollback_error rendered", () => {
    const out = renderAuditRow(
      row({
        state: "rollback_failed",
        error_log: "apply up failed",
        rollback_error: "rollback tag failed",
      }),
    );
    expect(out).toContain("state=rollback_failed");
    expect(out).toContain("error_log: apply up failed");
    expect(out).toContain("rollback_error: rollback tag failed");
  });

  test("tail_bytes truncates long error_log per-field with marker", () => {
    const long = "X".repeat(5000);
    const out = renderAuditRow(row({ error_log: long }), { tail_bytes: 100 });
    expect(out).toContain("[...4900 earlier bytes truncated]");
  });

  test("tail_bytes=0 elides log body but keeps the field line", () => {
    const out = renderAuditRow(row({ error_log: "anything" }), { tail_bytes: 0 });
    expect(out).toContain("error_log: [...");
    expect(out).toContain("bytes elided (tail_bytes=0)");
    expect(out).not.toContain("anything");
  });

  test("tail_bytes is clamped to MAX_LOG_TAIL_BYTES", () => {
    // No assertion against the actual byte count; just verify the
    // constant is honored and the function tolerates an over-cap input.
    expect(MAX_LOG_TAIL_BYTES).toBeGreaterThan(DEFAULT_LOG_TAIL_BYTES);
    const long = "Y".repeat(MAX_LOG_TAIL_BYTES + 1000);
    const out = renderAuditRow(row({ error_log: long }), { tail_bytes: 999_999 });
    expect(out).toContain("earlier bytes truncated");
  });

  test("prev_image_id null → no prev line", () => {
    const out = renderAuditRow(row({ prev_image_id: null }));
    expect(out).not.toContain("prev_image_id");
  });

  test("backup_path null → no backup line", () => {
    const out = renderAuditRow(row({ backup_path: null }));
    expect(out).not.toContain("backup:");
  });

  test("non-digest from/to (rare edge) passes through via shortDigest fallback", () => {
    const out = renderAuditRow(row({ from_digest: "weird", to_digest: null }));
    expect(out).toContain("from: weird");
    expect(out).toContain("to: (none)");
  });
});

describe("renderAuditList", () => {
  test("empty → friendly hint", () => {
    expect(renderAuditList([])).toContain("no update attempts recorded yet");
  });
  test("multi-row separated by blank line", () => {
    const out = renderAuditList([row({ id: 2 }), row({ id: 1 })]);
    expect(out.split("\n\n").length).toBe(2);
    expect(out).toContain("audit_id=2");
    expect(out).toContain("audit_id=1");
  });
});
