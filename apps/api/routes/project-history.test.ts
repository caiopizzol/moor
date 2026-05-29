// Integration test for #131 GET /api/projects/:id/stats/history — exercises
// the route param handling and getProjectHistory's DB fetch end to end.

process.env.MOOR_DB_PATH = ":memory:";

import { beforeEach, expect, test } from "bun:test";

const { default: db } = await import("./../db");
const { handleProjectHistory } = await import("./project-history");

function makeProject(name: string): number {
  const row = db.query("INSERT INTO projects (name) VALUES (?) RETURNING id").get(name) as {
    id: number;
  };
  return row.id;
}

function call(path: string, method = "GET") {
  const url = new URL(`http://localhost${path}`);
  return handleProjectHistory(new Request(url, { method }), url);
}

beforeEach(() => {
  db.query("DELETE FROM project_resource_samples").run();
  db.query("DELETE FROM project_events").run();
  db.query("DELETE FROM projects").run();
});

test("returns derived samples + events + summary for the window", async () => {
  const id = makeProject("p1");
  db.query(
    `INSERT INTO project_resource_samples
       (project_id, container_id, sampled_at_ms, status, cpu_total_ns, cpu_system_ns, online_cpus, mem_bytes, mem_limit_bytes)
     VALUES (?, 'c', 1000, 'running', 0, 0, 1, 100, 1000)`,
  ).run(id);
  db.query(
    `INSERT INTO project_resource_samples
       (project_id, container_id, sampled_at_ms, status, cpu_total_ns, cpu_system_ns, online_cpus, mem_bytes, mem_limit_bytes)
     VALUES (?, 'c', 61000, 'running', 5, 10, 1, 200, 1000)`,
  ).run(id);
  db.query(
    `INSERT INTO project_events (project_id, container_id, occurred_at_ms, source, action, created_at_ms)
     VALUES (?, 'c', 30000, 'docker_event', 'oom', 30000)`,
  ).run(id);

  const res = await call(`/api/projects/${id}/stats/history?from=0&to=100000`);
  expect(res?.status).toBe(200);
  const body = (await res!.json()) as {
    from_ms: number;
    to_ms: number;
    samples: Array<{ cpu_percent: number | null }>;
    events: Array<{ action: string }>;
    summary: { event_counts: Record<string, number>; cpu_percent_max: number | null };
  };
  expect(body.from_ms).toBe(0);
  expect(body.samples).toHaveLength(2);
  expect(body.samples[1].cpu_percent).toBe(50); // 5/10 * 1 core * 100
  expect(body.events).toHaveLength(1);
  expect(body.summary.event_counts.oom).toBe(1);
});

test("404 for a project that does not exist", async () => {
  const res = await call("/api/projects/9999/stats/history");
  expect(res?.status).toBe(404);
});

test("400 when from > to", async () => {
  const id = makeProject("p1");
  const res = await call(`/api/projects/${id}/stats/history?from=500&to=100`);
  expect(res?.status).toBe(400);
});

test("returns null for non-matching path (lets dispatch continue)", async () => {
  const res = await call("/api/projects/1/container-stats");
  expect(res).toBeNull();
});
