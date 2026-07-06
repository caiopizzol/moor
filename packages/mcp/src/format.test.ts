import { describe, expect, test } from "bun:test";
import { deriveRunStatus, formatBytes, renderDrainState } from "./format";

describe("formatBytes", () => {
  test("handles invalid and empty byte counts", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-1)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });

  test("uses compact binary units", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(10 * 1024 * 1024)).toBe("10 MB");
    expect(formatBytes(3.25 * 1024 ** 3)).toBe("3.3 GB");
  });
});

describe("deriveRunStatus", () => {
  test("uses finished_at and exit_code to derive agent-facing status", () => {
    expect(deriveRunStatus({ finished_at: null, exit_code: null })).toBe("running");
    expect(deriveRunStatus({ finished_at: "2026-07-06T12:00:00Z", exit_code: 0 })).toBe("success");
    expect(deriveRunStatus({ finished_at: "2026-07-06T12:00:00Z", exit_code: 2 })).toBe("failed");
    expect(deriveRunStatus({ finished_at: "2026-07-06T12:00:00Z", exit_code: null })).toBe(
      "failed",
    );
  });
});

describe("renderDrainState", () => {
  test("renders disabled drain mode as a single status line", () => {
    expect(
      renderDrainState({
        enabled: false,
        reason: null,
        started_at: null,
        expires_at: null,
        clear_after_version: null,
      }),
    ).toEqual(["drain: OFF"]);
  });

  test("renders enabled drain mode with auto-clear details", () => {
    expect(
      renderDrainState({
        enabled: true,
        reason: "updating moor",
        started_at: "2026-07-06T12:00:00Z",
        expires_at: "2026-07-06T12:30:00Z",
        clear_after_version: "0.54.0",
      }),
    ).toEqual([
      "drain: ON (reason: updating moor)",
      "  started_at:  2026-07-06T12:00:00Z",
      "  expires_at:  2026-07-06T12:30:00Z (auto-clear)",
      "  clear_after_version: 0.54.0 (auto-clear on matching boot version)",
    ]);
  });
});
