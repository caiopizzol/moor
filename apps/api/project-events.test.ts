// Tests for the project_events append path (#131 subsystem 2) and the two
// centralized state writers that feed it. The append path's dedup contract is
// load-bearing: Docker /events replays must collapse, but poll/action edges
// must each record.

process.env.MOOR_DB_PATH = ":memory:";

import { beforeEach, describe, expect, test } from "bun:test";

const { default: db } = await import("./db");
const { appendProjectEvent } = await import("./project-events");
const { setProjectLiveState, setProjectRecordedStatus } = await import("./status-reconciler");

function makeProject(name: string, status = "stopped", containerId: string | null = null): number {
  const row = db
    .query("INSERT INTO projects (name, status, container_id) VALUES (?, ?, ?) RETURNING id")
    .get(name, status, containerId) as { id: number };
  return row.id;
}

function events(projectId: number) {
  return db
    .query("SELECT * FROM project_events WHERE project_id = ? ORDER BY id")
    .all(projectId) as Array<{ source: string; action: string; time_nano: number | null }>;
}

beforeEach(() => {
  db.query("DELETE FROM project_events").run();
  db.query("DELETE FROM projects").run();
});

describe("appendProjectEvent — dedup contract", () => {
  test("replayed docker_event (same container_id, action, time_nano) inserts once", () => {
    const id = makeProject("p1");
    const first = appendProjectEvent({
      projectId: id,
      containerId: "abc",
      source: "docker_event",
      action: "die",
      occurredAtMs: 100,
      timeNano: 500,
    });
    const second = appendProjectEvent({
      projectId: id,
      containerId: "abc",
      source: "docker_event",
      action: "die",
      occurredAtMs: 100,
      timeNano: 500,
    });
    expect(first).toBe(true);
    expect(second).toBe(false); // deduped
    expect(events(id)).toHaveLength(1);
  });

  test("poll/action edges with null time_nano are all kept (NULLs distinct in UNIQUE)", () => {
    const id = makeProject("p1");
    appendProjectEvent({
      projectId: id,
      containerId: "abc",
      source: "poll",
      action: "live:running",
      occurredAtMs: 1,
    });
    appendProjectEvent({
      projectId: id,
      containerId: "abc",
      source: "poll",
      action: "live:running",
      occurredAtMs: 2,
    });
    expect(events(id)).toHaveLength(2);
  });

  test("raw payload is JSON-stringified; strings stored verbatim", () => {
    const id = makeProject("p1");
    appendProjectEvent({
      projectId: id,
      containerId: "abc",
      source: "docker_event",
      action: "oom",
      occurredAtMs: 1,
      timeNano: 1,
      raw: { Type: "container", Action: "oom" },
    });
    const row = db.query("SELECT raw_json FROM project_events WHERE project_id = ?").get(id) as {
      raw_json: string;
    };
    expect(JSON.parse(row.raw_json)).toEqual({ Type: "container", Action: "oom" });
  });
});

describe("setProjectLiveState — writes live_* and emits poll event on change", () => {
  test("emits live:<status> only when live_status actually changes", () => {
    const id = makeProject("p1");
    // first observation: null -> running is a change, records one event
    setProjectLiveState(id, "abc", "running", null);
    // repeat running: no change, no new event
    setProjectLiveState(id, "abc", "running", null);
    // transition to error: change, records
    setProjectLiveState(id, "abc", "error", 137);

    const evs = events(id);
    expect(evs.map((e) => e.action)).toEqual(["live:running", "live:error"]);
    expect(evs.every((e) => e.source === "poll")).toBe(true);

    const proj = db
      .query("SELECT live_status, live_exit_code FROM projects WHERE id = ?")
      .get(id) as {
      live_status: string;
      live_exit_code: number | null;
    };
    expect(proj.live_status).toBe("error");
    expect(proj.live_exit_code).toBe(137);
  });

  test("never mutates recorded status (#71 dual-field semantic)", () => {
    const id = makeProject("p1", "running");
    setProjectLiveState(id, "abc", "stopped", 0);
    const proj = db.query("SELECT status FROM projects WHERE id = ?").get(id) as { status: string };
    expect(proj.status).toBe("running");
  });
});

describe("setProjectRecordedStatus — writes status and emits moor_action event on change", () => {
  test("emits status:<value> only on change, with moor_action source", () => {
    const id = makeProject("p1", "stopped");
    setProjectRecordedStatus(id, "building", null);
    setProjectRecordedStatus(id, "building", null); // no change
    setProjectRecordedStatus(id, "running", "abc");

    const evs = events(id);
    expect(evs.map((e) => e.action)).toEqual(["status:building", "status:running"]);
    expect(evs.every((e) => e.source === "moor_action")).toBe(true);
  });

  test("never mutates live_* state", () => {
    const id = makeProject("p1");
    setProjectLiveState(id, "abc", "running", null);
    setProjectRecordedStatus(id, "stopped", "abc");
    const proj = db.query("SELECT live_status FROM projects WHERE id = ?").get(id) as {
      live_status: string;
    };
    expect(proj.live_status).toBe("running");
  });
});
