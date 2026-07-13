// Integration test for the #73 wiring in the manual cron trigger
// route. Same minimal pattern as exec.test.ts: verify the route
// calls requireLiveContainer and respects its result, using the
// no_container path so we don't depend on a real Docker daemon.

process.env.MOOR_DB_PATH = ":memory:";

import { beforeEach, describe, expect, test } from "bun:test";

const { default: db } = await import("../db");
const { handleCrons } = await import("./crons");

async function errorMessage(res: Response): Promise<string> {
  return ((await res.json()) as { error: string }).error;
}

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await handleCrons(req, new URL(req.url));
  if (!res) throw new Error(`handleCrons returned null for ${method} ${path}`);
  return res;
}

describe("#73 POST /api/crons/:id/run live-check wiring", () => {
  beforeEach(() => {
    db.query("DELETE FROM runs").run();
    db.query("DELETE FROM crons").run();
    db.query("DELETE FROM projects").run();
  });

  test("rejects with 400 no_container when target project has no container_id", async () => {
    const p = db
      .query("INSERT INTO projects (name, status) VALUES ('a', 'running') RETURNING id")
      .get() as { id: number };
    const cron = db
      .query(
        `INSERT INTO crons (project_id, name, schedule, command)
         VALUES (?, 'c', '* * * * *', 'echo') RETURNING id`,
      )
      .get(p.id) as { id: number };

    const res = await call("POST", `/api/crons/${cron.id}/run`);
    expect(res.status).toBe(400);
    expect(await errorMessage(res)).toBe("Project has no container; build/start it first");
    // Manual trigger should NOT have created a run row when the live
    // check rejected — the run row gets created inside runCron, which
    // we never reach.
    const runs = db.query("SELECT COUNT(*) as n FROM runs WHERE cron_id = ?").get(cron.id) as {
      n: number;
    };
    expect(runs.n).toBe(0);
  });
});

describe("cron timeout configuration", () => {
  beforeEach(() => {
    db.query("DELETE FROM runs").run();
    db.query("DELETE FROM crons").run();
    db.query("DELETE FROM projects").run();
  });

  test("create defaults to 10 minutes and accepts a multi-hour timeout", async () => {
    const project = db
      .query("INSERT INTO projects (name) VALUES ('timeouts') RETURNING id")
      .get() as { id: number };

    const defaultRes = await call("POST", `/api/projects/${project.id}/crons`, {
      name: "default",
      schedule: "0 3 * * *",
      command: "echo default",
    });
    expect(defaultRes.status).toBe(201);
    expect((await defaultRes.json()) as { timeout_ms: number }).toMatchObject({
      timeout_ms: 600_000,
    });

    const longRes = await call("POST", `/api/projects/${project.id}/crons`, {
      name: "pipeline",
      schedule: "30 7 * * *",
      command: "run-pipeline",
      timeout_ms: 6 * 60 * 60 * 1000,
    });
    expect(longRes.status).toBe(201);
    expect((await longRes.json()) as { timeout_ms: number }).toMatchObject({
      timeout_ms: 21_600_000,
    });
  });

  test("create and update reject invalid timeouts", async () => {
    const project = db
      .query("INSERT INTO projects (name) VALUES ('invalid-timeout') RETURNING id")
      .get() as { id: number };

    const createRes = await call("POST", `/api/projects/${project.id}/crons`, {
      name: "bad",
      schedule: "0 3 * * *",
      command: "echo bad",
      timeout_ms: 999,
    });
    expect(createRes.status).toBe(400);
    expect(await errorMessage(createRes)).toContain("timeout_ms must be an integer between");

    const cron = db
      .query(
        "INSERT INTO crons (project_id, name, schedule, command) VALUES (?, 'c', '* * * * *', 'echo') RETURNING id",
      )
      .get(project.id) as { id: number };
    const updateRes = await call("PUT", `/api/crons/${cron.id}`, { timeout_ms: 604_800_001 });
    expect(updateRes.status).toBe(400);
    expect(await errorMessage(updateRes)).toContain("timeout_ms must be an integer between");
  });

  test("update persists the timeout", async () => {
    const project = db
      .query("INSERT INTO projects (name) VALUES ('update-timeout') RETURNING id")
      .get() as { id: number };
    const cron = db
      .query(
        "INSERT INTO crons (project_id, name, schedule, command) VALUES (?, 'c', '* * * * *', 'echo') RETURNING id",
      )
      .get(project.id) as { id: number };

    const res = await call("PUT", `/api/crons/${cron.id}`, { timeout_ms: 10_800_000 });
    expect(res.status).toBe(200);
    expect((await res.json()) as { timeout_ms: number }).toMatchObject({ timeout_ms: 10_800_000 });
  });
});
