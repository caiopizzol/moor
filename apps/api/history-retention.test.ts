// Tests for #131 retention: prune by cutoff, and the days-resolution that must
// never silently disable the leak-prevention default.

process.env.MOOR_DB_PATH = ":memory:";

import { beforeEach, describe, expect, test } from "bun:test";

const { default: db } = await import("./db");
const { pruneHistory, resolveRetentionDays, runRetention } = await import("./history-retention");

function makeProject(name: string): number {
  const row = db.query("INSERT INTO projects (name) VALUES (?) RETURNING id").get(name) as {
    id: number;
  };
  return row.id;
}

beforeEach(() => {
  db.query("DELETE FROM project_resource_samples").run();
  db.query("DELETE FROM project_events").run();
  db.query("DELETE FROM projects").run();
});

describe("resolveRetentionDays", () => {
  test("defaults to 30 for unset/invalid; never disables", () => {
    expect(resolveRetentionDays(undefined)).toBe(30);
    expect(resolveRetentionDays("")).toBe(30);
    expect(resolveRetentionDays("0")).toBe(30);
    expect(resolveRetentionDays("-5")).toBe(30);
    expect(resolveRetentionDays("abc")).toBe(30);
    expect(resolveRetentionDays("7")).toBe(7);
  });
});

describe("pruneHistory", () => {
  test("deletes samples and events older than the cutoff, keeps newer", () => {
    const id = makeProject("p1");
    db.query(
      "INSERT INTO project_resource_samples (project_id, container_id, sampled_at_ms, status) VALUES (?, 'c', 100, 'running')",
    ).run(id);
    db.query(
      "INSERT INTO project_resource_samples (project_id, container_id, sampled_at_ms, status) VALUES (?, 'c', 5000, 'running')",
    ).run(id);
    db.query(
      "INSERT INTO project_events (project_id, container_id, occurred_at_ms, source, action, created_at_ms) VALUES (?, 'c', 100, 'poll', 'live:running', 100)",
    ).run(id);
    db.query(
      "INSERT INTO project_events (project_id, container_id, occurred_at_ms, source, action, created_at_ms) VALUES (?, 'c', 5000, 'poll', 'live:stopped', 5000)",
    ).run(id);

    const removed = pruneHistory(1000);
    expect(removed.samples).toBe(1);
    expect(removed.events).toBe(1);

    const sampleCount = db.query("SELECT COUNT(*) n FROM project_resource_samples").get() as {
      n: number;
    };
    expect(sampleCount.n).toBe(1);
  });

  test("runRetention computes cutoff from now - days", () => {
    const id = makeProject("p1");
    const now = 1_000_000_000;
    const dayMs = 24 * 60 * 60 * 1000;
    // one sample 40 days old, one 5 days old
    db.query(
      "INSERT INTO project_resource_samples (project_id, container_id, sampled_at_ms, status) VALUES (?, 'c', ?, 'running')",
    ).run(id, now - 40 * dayMs);
    db.query(
      "INSERT INTO project_resource_samples (project_id, container_id, sampled_at_ms, status) VALUES (?, 'c', ?, 'running')",
    ).run(id, now - 5 * dayMs);

    runRetention(30, now);
    const left = db.query("SELECT COUNT(*) n FROM project_resource_samples").get() as { n: number };
    expect(left.n).toBe(1); // 40d pruned, 5d kept
  });
});
