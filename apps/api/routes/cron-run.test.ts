process.env.MOOR_DB_PATH = ":memory:";

import { beforeEach, expect, test } from "bun:test";

const { activeRuns, startCron, stopCronRun, interruptActiveRuns } = await import("../cron");
const { default: db } = await import("../db");
const { handleCrons } = await import("./crons");
const { handleRuns } = await import("./runs");

beforeEach(() => {
  db.query("DELETE FROM runs").run();
  db.query("DELETE FROM crons").run();
  db.query("DELETE FROM projects").run();
});

function fixture() {
  const project = db
    .query("INSERT INTO projects (name, container_id) VALUES ('worker', 'container') RETURNING id")
    .get() as { id: number };
  return db
    .query(
      "INSERT INTO crons (project_id, name, schedule, command) VALUES (?, 'task', '* * * * *', 'echo task') RETURNING *",
    )
    .get(project.id) as Parameters<typeof startCron>[0];
}

test("cron completion preserves the shutdown terminal record", async () => {
  const gate = Promise.withResolvers<void>();
  const handle = startCron(fixture(), "container", async () => {
    await gate.promise;
    return { exitCode: 0, stdout: "late output", stderr: "" };
  });
  interruptActiveRuns();
  const terminal = db.query("SELECT * FROM runs WHERE id = ?").get(handle.runId);
  gate.resolve();
  await handle.completion;
  expect(terminal).toMatchObject({
    exit_code: -1,
    stderr: "[moor shutting down; cron run aborted]",
  });
  expect(db.query("SELECT * FROM runs WHERE id = ?").get(handle.runId)).toEqual(terminal);
  expect(activeRuns.has(handle.runId)).toBe(false);
});

test("cron cancellation preserves kill outcomes and shares concurrent stop attempts", async () => {
  for (const scenario of [
    "clean",
    "survivors",
    "resolved-survivors",
    "unknown",
    "throws",
    "pre-exec",
  ]) {
    const handle = startCron(fixture(), "container", async (_id, _command, options) => {
      if (scenario !== "pre-exec") options?.onExecId?.("exec-1");
      await new Promise<void>((resolve, reject) =>
        options?.signal?.addEventListener(
          "abort",
          () => (scenario === "resolved-survivors" ? resolve() : reject(new Error("aborted"))),
          {
            once: true,
          },
        ),
      );
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const gate = Promise.withResolvers<void>();
    let calls = 0;
    const stop = (id: number) =>
      stopCronRun(id, async (execId) => {
        calls++;
        expect(execId).toBe("exec-1");
        await gate.promise;
        if (scenario === "throws") throw new Error("kill unavailable");
        return {
          ok: scenario === "clean",
          sentTo: "42",
          live: scenario.includes("survivors") ? 2 : 0,
        };
      });
    const req = new Request(`http://localhost/api/runs/${handle.runId}/stop`, { method: "POST" });
    const first = handleRuns(req, new URL(req.url), stop);
    const second = handleRuns(req, new URL(req.url), stop);
    gate.resolve();
    const [response, duplicate] = await Promise.all([first, second]);
    await handle.completion;
    expect(response?.status).toBe(scenario === "clean" ? 200 : 409);
    const body = await response?.json();
    expect(await duplicate?.json()).toEqual(body);
    expect(body).toMatchObject({
      ok: scenario === "clean",
      result: scenario === "clean" ? "cancelled_cron" : "cron_kill_incomplete",
    });
    expect(calls).toBe(scenario === "pre-exec" ? 0 : 1);
    const row = db
      .query("SELECT exit_code, stderr, finished_at FROM runs WHERE id = ?")
      .get(handle.runId) as { exit_code: number; stderr: string; finished_at: string };
    expect(row.exit_code).toBe(-1);
    expect(row.finished_at).toBeString();
    expect(row.stderr).toContain(
      scenario === "clean" ? "Stopped by user" : "process state unknown",
    );
    if (scenario.includes("survivors")) {
      expect(body.live_remaining).toBe(2);
      expect(row.stderr).toContain("2 known survivor(s)");
    }
    expect(activeRuns.has(handle.runId)).toBe(false);
    db.query("DELETE FROM runs").run();
    db.query("DELETE FROM crons").run();
    db.query("DELETE FROM projects").run();
  }
});

test("manual cron acceptance returns distinct tracked IDs before execution completes", async () => {
  const cron = fixture();
  const pending: Array<{ finish: () => void; completion: Promise<void>; id: number }> = [];
  try {
    for (let index = 0; index < 2; index++) {
      const gate = Promise.withResolvers<void>();
      const req = new Request(`http://localhost/api/crons/${cron.id}/run`, { method: "POST" });
      const response = await handleCrons(req, new URL(req.url), {
        requireLiveContainer: async (project) => {
          expect(project.container_id).toBe("container");
          return { ok: true };
        },
        startCron: (row, container) => {
          const handle = startCron(row, container, async (id, command) => {
            expect(id).toBe("container");
            expect(command).toBe("echo task");
            await gate.promise;
            return { exitCode: 3, stdout: "output", stderr: "failure" };
          });
          pending.push({
            finish: () => gate.resolve(),
            completion: handle.completion,
            id: handle.runId,
          });
          return handle;
        },
      });
      expect(response?.status).toBe(200);
      const body = await response?.json();
      expect(body).toEqual({ ok: true, run_id: pending[index].id });
      expect(body.run_id).toBeGreaterThan(0);
      expect(activeRuns.has(body.run_id)).toBe(true);
      expect(
        db.query("SELECT cron_id, project_id, finished_at FROM runs WHERE id = ?").get(body.run_id),
      ).toEqual({ cron_id: cron.id, project_id: cron.project_id, finished_at: null });
    }
    expect(pending[0].id).not.toBe(pending[1].id);
  } finally {
    for (const item of pending) item.finish();
    await Promise.all(pending.map((item) => item.completion));
  }
  for (const item of pending) {
    expect(activeRuns.has(item.id)).toBe(false);
    expect(
      (
        db.query("SELECT finished_at FROM runs WHERE id = ?").get(item.id) as {
          finished_at: string;
        }
      ).finished_at,
    ).toBeString();
    expect(
      db.query("SELECT exit_code, stdout, stderr FROM runs WHERE id = ?").get(item.id),
    ).toEqual({ exit_code: 3, stdout: "output", stderr: "failure" });
  }
});

test("accepted cron execution errors finalize the returned run and clear active state", async () => {
  const handle = startCron(fixture(), "container", async () => {
    throw new Error("execution unavailable");
  });
  await handle.completion;
  expect(activeRuns.has(handle.runId)).toBe(false);
  expect(db.query("SELECT exit_code, stderr FROM runs WHERE id = ?").get(handle.runId)).toEqual({
    exit_code: -1,
    stderr: "execution unavailable",
  });
  expect(
    (
      db.query("SELECT finished_at FROM runs WHERE id = ?").get(handle.runId) as {
        finished_at: string;
      }
    ).finished_at,
  ).toBeString();
});
