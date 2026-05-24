// Integration test for the #73 wiring in the async-exec route. The
// requireLiveContainer helper itself is unit-tested in
// status-reconciler.test.ts; this asserts the ROUTE calls it and
// respects its result.
//
// We use container_id=NULL (no_container path) because it exercises
// the integration without depending on a real Docker daemon being
// reachable in the test environment.

process.env.MOOR_DB_PATH = ":memory:";

import { beforeEach, describe, expect, test } from "bun:test";

const { default: db } = await import("../db");
const { handleExec } = await import("./exec");

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const res = await handleExec(req, new URL(req.url));
  if (!res) throw new Error(`handleExec returned null for ${method} ${path}`);
  return res;
}

describe("#73 POST /api/projects/:id/exec/async live-check wiring", () => {
  beforeEach(() => {
    db.query("DELETE FROM projects").run();
  });

  test("rejects with 400 no_container when project has no container_id", async () => {
    // Project recorded as 'running' but never actually had a container.
    // Pre-#73 this could have proceeded based on the recorded status;
    // after #73 the live check sees container_id=NULL and rejects.
    const p = db
      .query("INSERT INTO projects (name, status) VALUES ('a', 'running') RETURNING id")
      .get() as { id: number };

    const res = await call("POST", `/api/projects/${p.id}/exec/async`, {
      command: "echo hi",
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Project has no container; build/start it first");
  });

  test("input validation (bad timeout_ms) still fires before the live check", async () => {
    // Ordering matters: validating cheap inputs first means a bad
    // timeout_ms gets a useful 400, not a 503 docker_error the
    // operator can't act on. Same project shape as the no_container
    // test but bad timeout_ms — should return the validation error.
    const p = db
      .query("INSERT INTO projects (name, status) VALUES ('b', 'running') RETURNING id")
      .get() as { id: number };

    const res = await call("POST", `/api/projects/${p.id}/exec/async`, {
      command: "echo hi",
      timeout_ms: 500, // below the min
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("timeout_ms must be an integer between");
  });
});
