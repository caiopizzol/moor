process.env.MOOR_DB_PATH = ":memory:";

import { beforeEach, describe, expect, test } from "bun:test";

let observedTimeout: number | undefined;

const { default: db } = await import("./db");
const { runCron } = await import("./cron");

describe("cron timeout execution", () => {
  beforeEach(() => {
    observedTimeout = undefined;
    db.query("DELETE FROM runs").run();
    db.query("DELETE FROM crons").run();
    db.query("DELETE FROM projects").run();
  });

  test("passes the cron's configured timeout to the container exec", async () => {
    const project = db
      .query("INSERT INTO projects (name) VALUES ('pipeline') RETURNING id")
      .get() as { id: number };
    const cron = db
      .query(
        `INSERT INTO crons (project_id, name, schedule, command, timeout_ms)
         VALUES (?, 'refresh', '30 7 * * *', 'run-pipeline', 86400000)
         RETURNING *`,
      )
      .get(project.id) as {
      id: number;
      project_id: number;
      name: string;
      schedule: string;
      command: string;
      timeout_ms: number;
      enabled: number;
    };

    await runCron(cron, "container-id", async (_containerId, _command, opts) => {
      observedTimeout = opts?.timeout_ms;
      opts?.onExecId?.("exec-1");
      return { exitCode: 0, stdout: "ok", stderr: "" };
    });

    expect(observedTimeout).toBe(86_400_000);
    const run = db.query("SELECT exit_code, stdout FROM runs WHERE cron_id = ?").get(cron.id) as {
      exit_code: number;
      stdout: string;
    };
    expect(run).toEqual({ exit_code: 0, stdout: "ok" });
  });
});
