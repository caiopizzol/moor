// Integration test for the #73 wiring in the manual cron trigger
// route. Same minimal pattern as exec.test.ts: verify the route
// calls requireLiveContainer and respects its result, using the
// no_container path so we don't depend on a real Docker daemon.

process.env.MOOR_DB_PATH = ":memory:";

import { beforeEach, describe, expect, test } from "bun:test";

const { default: db } = await import("../db");
const { handleCrons } = await import("./crons");

async function call(method: string, path: string): Promise<Response> {
  const req = new Request(`http://localhost${path}`, { method });
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
    expect(await res.text()).toBe("Project has no container; build/start it first");
    // Manual trigger should NOT have created a run row when the live
    // check rejected — the run row gets created inside runCron, which
    // we never reach.
    const runs = db.query("SELECT COUNT(*) as n FROM runs WHERE cron_id = ?").get(cron.id) as {
      n: number;
    };
    expect(runs.n).toBe(0);
  });
});
