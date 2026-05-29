// Tests for #131 subsystem 5: Docker /events normalization, correlation, and
// the gap decision. The streaming/reconnect loop is the imperative shell
// (smoke-covered); these exercise the pure + db-backed pieces.

process.env.MOOR_DB_PATH = ":memory:";

import { beforeEach, describe, expect, test } from "bun:test";

const { default: db } = await import("./db");
const { normalizeDockerEvent, ingestDockerEvent, shouldRecordGap } = await import(
  "./docker-events"
);
const { LABEL_PROJECT_ID } = await import("./docker");

function makeProject(name: string, containerId: string | null): number {
  const row = db
    .query("INSERT INTO projects (name, container_id) VALUES (?, ?) RETURNING id")
    .get(name, containerId) as { id: number };
  return row.id;
}

function events(projectId: number) {
  return db
    .query("SELECT * FROM project_events WHERE project_id = ? ORDER BY id")
    .all(projectId) as Array<{ source: string; action: string; time_nano: number | null }>;
}

function dockerEvent(action: string, containerId: string, projectId: number, timeNano: number) {
  return {
    Type: "container",
    Action: action,
    Actor: {
      ID: containerId,
      Attributes: { image: "img", name: "moor-p", [LABEL_PROJECT_ID]: String(projectId) },
    },
    time: Math.floor(timeNano / 1e9),
    timeNano,
  };
}

beforeEach(() => {
  db.query("DELETE FROM project_events").run();
  db.query("DELETE FROM projects").run();
});

describe("normalizeDockerEvent", () => {
  test("keeps recorded container actions, drops the rest", () => {
    expect(normalizeDockerEvent(dockerEvent("die", "c1", 1, 5))?.action).toBe("die");
    expect(normalizeDockerEvent(dockerEvent("oom", "c1", 1, 5))?.action).toBe("oom");
    // non-recorded action
    expect(normalizeDockerEvent(dockerEvent("exec_start", "c1", 1, 5))).toBeNull();
    // non-container event
    expect(normalizeDockerEvent({ Type: "network", Action: "connect" })).toBeNull();
    // health_status:... keys on the head token
    expect(
      normalizeDockerEvent({ ...dockerEvent("die", "c1", 1, 5), Action: "die: oops" })?.action,
    ).toBe("die");
  });

  test("rejects malformed events", () => {
    expect(normalizeDockerEvent(null)).toBeNull();
    expect(normalizeDockerEvent({ Type: "container", Action: "die", Actor: {} })).toBeNull();
  });
});

describe("ingestDockerEvent", () => {
  test("correlates via label and records a docker_event row", () => {
    const id = makeProject("p1", "c1");
    const inserted = ingestDockerEvent(dockerEvent("oom", "c1", id, 1_000_000_000));
    expect(inserted).toBe(true);
    const evs = events(id);
    expect(evs).toHaveLength(1);
    expect(evs[0].source).toBe("docker_event");
    expect(evs[0].action).toBe("oom");
    expect(evs[0].time_nano).toBe(1_000_000_000);
  });

  test("replayed event (same container_id, action, time_nano) deduped", () => {
    const id = makeProject("p1", "c1");
    expect(ingestDockerEvent(dockerEvent("die", "c1", id, 42))).toBe(true);
    expect(ingestDockerEvent(dockerEvent("die", "c1", id, 42))).toBe(false);
    expect(events(id)).toHaveLength(1);
  });

  test("uncorrelated event (no project) is ignored", () => {
    makeProject("p1", "c1");
    // label points at a non-existent project and container_id doesn't match
    const ev = dockerEvent("die", "unknown-c", 9999, 5);
    expect(ingestDockerEvent(ev)).toBe(false);
  });

  test("OOM is recorded as its own action, distinct from die", () => {
    const id = makeProject("p1", "c1");
    ingestDockerEvent(dockerEvent("oom", "c1", id, 1));
    ingestDockerEvent(dockerEvent("die", "c1", id, 2));
    expect(events(id).map((e) => e.action)).toEqual(["oom", "die"]);
  });
});

describe("shouldRecordGap", () => {
  test("no gap on first connect", () => {
    expect(shouldRecordGap(null, 1_000_000, 30_000)).toBe(false);
  });
  test("gap only when reconnect exceeds threshold", () => {
    expect(shouldRecordGap(1_000_000, 1_010_000, 30_000)).toBe(false); // 10s blip
    expect(shouldRecordGap(1_000_000, 1_040_000, 30_000)).toBe(true); // 40s outage
  });
});
