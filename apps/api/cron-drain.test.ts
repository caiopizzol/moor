// #79 acceptance: enable drain → cron tick fires for a scheduled job →
// runs row exists with stderr "skipped due to drain", finished_at set,
// exit_code=-1, started_at_ms populated (sortable in moor_runs).

process.env.MOOR_DB_PATH = ":memory:";

import { beforeEach, describe, expect, test } from "bun:test";

const { default: db } = await import("./db");
const { disableDrain, enableDrain } = await import("./drain");
const { tickInner } = await import("./cron");

describe("#79 cron tick during drain", () => {
  beforeEach(() => {
    db.query("DELETE FROM runs").run();
    db.query("DELETE FROM crons").run();
    db.query("DELETE FROM projects").run();
    disableDrain();
  });

  test("drain on + matching cron → synthetic skip row, not real exec", async () => {
    // Schedule '* * * * *' matches every minute; the tick will pick it up.
    // container_id is irrelevant when drained — the gate fires before any
    // container check.
    const p = db.query("INSERT INTO projects (name) VALUES ('p') RETURNING id").get() as {
      id: number;
    };
    const c = db
      .query(
        "INSERT INTO crons (project_id, name, schedule, command) VALUES (?, 'c', '* * * * *', 'echo hi') RETURNING id",
      )
      .get(p.id) as { id: number };

    enableDrain({ reason: "upgrading to 0.34", ttl_minutes: 30 });
    await tickInner();

    const rows = db
      .query("SELECT * FROM runs WHERE cron_id = ? ORDER BY id DESC")
      .all(c.id) as Array<{
      stderr: string;
      finished_at: string | null;
      finished_at_ms: number | null;
      started_at_ms: number | null;
      exit_code: number | null;
      duration_ms: number | null;
    }>;
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.stderr).toContain("skipped due to drain");
    expect(row.stderr).toContain("upgrading to 0.34");
    expect(row.exit_code).toBe(-1);
    expect(row.finished_at).not.toBeNull();
    expect(row.finished_at_ms).not.toBeNull();
    expect(row.started_at_ms).not.toBeNull();
    // duration_ms=0 is the documented synthetic-skip shape (instantaneous).
    expect(row.duration_ms).toBe(0);
  });

  test("drain off → no synthetic skip row written (regular tick path takes over)", async () => {
    // With drain off and no container_id, the tick would hit
    // requireLiveContainer → no_container → write a regular skip row.
    // We're asserting drain isn't the source of the row.
    const p = db.query("INSERT INTO projects (name) VALUES ('p') RETURNING id").get() as {
      id: number;
    };
    db.query(
      "INSERT INTO crons (project_id, name, schedule, command) VALUES (?, 'c', '* * * * *', 'echo hi')",
    ).run(p.id);

    await tickInner();

    const rows = db.query("SELECT stderr FROM runs").all() as Array<{ stderr: string }>;
    // There should be a skip row but it should be the no_container one,
    // not the drain one.
    for (const r of rows) {
      expect(r.stderr).not.toContain("skipped due to drain");
    }
  });
});
