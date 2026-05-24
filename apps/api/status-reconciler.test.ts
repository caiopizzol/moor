// Tests for #71 status reconciler. The realInspect Docker round-trip
// is covered by live smoke; here we exercise the pure parser and the
// reconciler logic via an injectable Inspector mock.

process.env.MOOR_DB_PATH = ":memory:";

import { beforeEach, describe, expect, test } from "bun:test";

const { default: db } = await import("./db");
const { parseContainerState, reconcileOnce, requireLiveContainer, liveRequireErrorResponse } =
  await import("./status-reconciler");

import type { Inspector } from "./status-reconciler";

function makeProject(name: string, status: string, containerId: string | null): { id: number } {
  return db
    .query(
      `INSERT INTO projects (name, status, container_id)
       VALUES (?, ?, ?) RETURNING id`,
    )
    .get(name, status, containerId) as { id: number };
}

describe("#71 parseContainerState — pure mapping", () => {
  test("Running:true → live_status='running', exit code null", () => {
    expect(parseContainerState({ Running: true, ExitCode: 0 })).toEqual({
      live_status: "running",
      live_exit_code: null,
    });
    // ExitCode may be non-zero on a still-running container (stale Docker
    // field from a prior incarnation); Running:true wins.
    expect(parseContainerState({ Running: true, ExitCode: 137 })).toEqual({
      live_status: "running",
      live_exit_code: null,
    });
  });

  test("Running:false + ExitCode=0 → 'stopped'", () => {
    expect(parseContainerState({ Running: false, ExitCode: 0 })).toEqual({
      live_status: "stopped",
      live_exit_code: 0,
    });
  });

  test("Running:false + ExitCode!=0 → 'error' with the exit code preserved", () => {
    expect(parseContainerState({ Running: false, ExitCode: 1 })).toEqual({
      live_status: "error",
      live_exit_code: 1,
    });
    expect(parseContainerState({ Running: false, ExitCode: 137 })).toEqual({
      live_status: "error",
      live_exit_code: 137,
    });
  });

  test("OOMKilled is 'error' even with ExitCode=0 (kernel killed before code was set)", () => {
    expect(parseContainerState({ Running: false, ExitCode: 0, OOMKilled: true })).toEqual({
      live_status: "error",
      live_exit_code: 0,
    });
  });
});

describe("#71 reconcileOnce — dual-field model, both directions", () => {
  beforeEach(() => {
    db.query("DELETE FROM projects").run();
  });

  function mockInspect(map: Record<string, Awaited<ReturnType<Inspector>>>): Inspector {
    return async (containerId: string) => {
      const result = map[containerId];
      if (!result) throw new Error(`mockInspect missing fixture for ${containerId}`);
      return result;
    };
  }

  test("DB says running, Docker says Exited(1) → live_status='error', exit_code=1, recorded stays untouched", async () => {
    const p = makeProject("a", "running", "container-A");
    await reconcileOnce(
      mockInspect({
        "container-A": { ok: true, state: { Running: false, ExitCode: 1 } },
      }),
    );
    const row = db
      .query("SELECT status, live_status, live_exit_code, live_error FROM projects WHERE id = ?")
      .get(p.id) as {
      status: string;
      live_status: string;
      live_exit_code: number;
      live_error: string | null;
    };
    expect(row.status).toBe("running"); // unmutated — recorded state preserved
    expect(row.live_status).toBe("error");
    expect(row.live_exit_code).toBe(1);
    expect(row.live_error).toBeNull();
  });

  test("DB says error, Docker says running → live_status='running', recorded stays 'error'", async () => {
    // Proves the dual-field model works in BOTH directions, not just
    // catching missed exits.
    const p = makeProject("a", "error", "container-A");
    await reconcileOnce(
      mockInspect({
        "container-A": { ok: true, state: { Running: true, ExitCode: 0 } },
      }),
    );
    const row = db
      .query("SELECT status, live_status, live_exit_code FROM projects WHERE id = ?")
      .get(p.id) as {
      status: string;
      live_status: string;
      live_exit_code: number | null;
    };
    expect(row.status).toBe("error");
    expect(row.live_status).toBe("running");
    expect(row.live_exit_code).toBeNull();
  });

  test("Docker 404 → live_status='missing', exit_code=null", async () => {
    const p = makeProject("a", "running", "container-gone");
    await reconcileOnce(mockInspect({ "container-gone": { ok: false, kind: "missing" } }));
    const row = db
      .query("SELECT live_status, live_exit_code, live_error FROM projects WHERE id = ?")
      .get(p.id) as {
      live_status: string;
      live_exit_code: number | null;
      live_error: string | null;
    };
    expect(row.live_status).toBe("missing");
    expect(row.live_exit_code).toBeNull();
    expect(row.live_error).toBeNull();
  });

  test("inspect failure → preserves prior live_*, records live_error (load-bearing)", async () => {
    // A periodic loop must NOT rewrite truth from a transient daemon
    // glitch. Seed the row with a prior successful live_status='running',
    // then have the inspector fail; live_status must stay 'running' AND
    // live_checked_at must NOT advance — otherwise MCP would show a
    // fresh timestamp next to a stale snapshot, contradicting the
    // "last successful inspect" semantic the description promises.
    const p = makeProject("a", "running", "container-A");
    await reconcileOnce(
      mockInspect({
        "container-A": { ok: true, state: { Running: true, ExitCode: 0 } },
      }),
    );
    let row = db
      .query("SELECT live_status, live_checked_at, live_error FROM projects WHERE id = ?")
      .get(p.id) as {
      live_status: string;
      live_checked_at: string;
      live_error: string | null;
    };
    expect(row.live_status).toBe("running");
    expect(row.live_error).toBeNull();
    const firstCheckedAt = row.live_checked_at;

    // Now simulate Docker socket unreachable. Wait at least one second
    // so a buggy implementation that advanced live_checked_at would
    // produce a visibly different timestamp (SQLite datetime() is
    // second-precision).
    await new Promise((r) => setTimeout(r, 1100));
    await reconcileOnce(
      mockInspect({
        "container-A": { ok: false, kind: "error", message: "ECONNREFUSED" },
      }),
    );
    row = db
      .query("SELECT live_status, live_checked_at, live_error FROM projects WHERE id = ?")
      .get(p.id) as {
      live_status: string;
      live_checked_at: string;
      live_error: string | null;
    };
    expect(row.live_status).toBe("running"); // preserved!
    expect(row.live_error).toBe("ECONNREFUSED");
    expect(row.live_checked_at).toBe(firstCheckedAt); // preserved!

    // Next successful inspect clears live_error and updates checked_at.
    await reconcileOnce(
      mockInspect({
        "container-A": { ok: true, state: { Running: false, ExitCode: 0 } },
      }),
    );
    row = db
      .query("SELECT live_status, live_checked_at, live_error FROM projects WHERE id = ?")
      .get(p.id) as {
      live_status: string;
      live_checked_at: string;
      live_error: string | null;
    };
    expect(row.live_status).toBe("stopped");
    expect(row.live_error).toBeNull();
    expect(row.live_checked_at).not.toBe(firstCheckedAt); // advanced
  });

  test("projects with container_id IS NULL are skipped — no inspect calls", async () => {
    makeProject("never-started", "stopped", null);
    let calls = 0;
    await reconcileOnce(async () => {
      calls++;
      return { ok: true, state: { Running: true, ExitCode: 0 } };
    });
    expect(calls).toBe(0);
  });

  test("walks every project with container_id, not just status='running'", async () => {
    // Otherwise we'd miss the "recorded stopped but actually running"
    // direction. Three projects, one of each recorded status.
    const a = makeProject("a", "running", "c1");
    const b = makeProject("b", "stopped", "c2");
    const c = makeProject("c", "error", "c3");

    await reconcileOnce(
      mockInspect({
        c1: { ok: true, state: { Running: false, ExitCode: 1 } },
        c2: { ok: true, state: { Running: true, ExitCode: 0 } },
        c3: { ok: true, state: { Running: true, ExitCode: 0 } },
      }),
    );

    const rows = db
      .query(`SELECT id, status, live_status FROM projects WHERE id IN (?, ?, ?) ORDER BY id`)
      .all(a.id, b.id, c.id) as Array<{ id: number; status: string; live_status: string }>;
    expect(rows[0]).toMatchObject({ status: "running", live_status: "error" });
    expect(rows[1]).toMatchObject({ status: "stopped", live_status: "running" });
    expect(rows[2]).toMatchObject({ status: "error", live_status: "running" });
  });
});

describe("#73 requireLiveContainer — action-path gate", () => {
  beforeEach(() => {
    db.query("DELETE FROM projects").run();
  });

  function mockInspect(map: Record<string, Awaited<ReturnType<Inspector>>>): Inspector {
    return async (containerId: string) => {
      const r = map[containerId];
      if (!r) throw new Error(`mockInspect missing fixture for ${containerId}`);
      return r;
    };
  }

  test("container_id null → no_container (no Docker call)", async () => {
    const p = db
      .query("INSERT INTO projects (name, status) VALUES ('a', 'running') RETURNING id")
      .get() as { id: number };
    let inspectCalls = 0;
    const result = await requireLiveContainer({ id: p.id, container_id: null }, async () => {
      inspectCalls++;
      throw new Error("should not be called");
    });
    expect(result).toEqual({ ok: false, reason: "no_container" });
    expect(inspectCalls).toBe(0);
  });

  test("Docker says Running:true → ok, opportunistically writes live_*", async () => {
    const p = db
      .query(
        "INSERT INTO projects (name, status, container_id) VALUES ('a', 'error', 'C') RETURNING id",
      )
      .get() as { id: number };
    const result = await requireLiveContainer(
      { id: p.id, container_id: "C" },
      mockInspect({ C: { ok: true, state: { Running: true, ExitCode: 0 } } }),
    );
    expect(result).toEqual({ ok: true });
    // Side effect: live_* updated from the fresh inspect.
    const row = db
      .query("SELECT live_status, live_exit_code FROM projects WHERE id = ?")
      .get(p.id) as { live_status: string; live_exit_code: number | null };
    expect(row.live_status).toBe("running");
    expect(row.live_exit_code).toBeNull();
  });

  test("Docker says exited(1) → not_running with live_status='error'", async () => {
    const p = db
      .query(
        "INSERT INTO projects (name, status, container_id) VALUES ('a', 'running', 'C') RETURNING id",
      )
      .get() as { id: number };
    const result = await requireLiveContainer(
      { id: p.id, container_id: "C" },
      mockInspect({ C: { ok: true, state: { Running: false, ExitCode: 1 } } }),
    );
    expect(result).toEqual({ ok: false, reason: "not_running", live_status: "error" });
  });

  test("Docker 404 → missing", async () => {
    const p = db
      .query(
        "INSERT INTO projects (name, status, container_id) VALUES ('a', 'running', 'C') RETURNING id",
      )
      .get() as { id: number };
    const result = await requireLiveContainer(
      { id: p.id, container_id: "C" },
      mockInspect({ C: { ok: false, kind: "missing" } }),
    );
    expect(result).toEqual({ ok: false, reason: "missing" });
  });

  test("Docker unreachable → docker_error (distinct from not_running)", async () => {
    const p = db
      .query(
        "INSERT INTO projects (name, status, container_id) VALUES ('a', 'running', 'C') RETURNING id",
      )
      .get() as { id: number };
    const result = await requireLiveContainer(
      { id: p.id, container_id: "C" },
      mockInspect({ C: { ok: false, kind: "error", message: "ECONNREFUSED" } }),
    );
    expect(result).toEqual({ ok: false, reason: "docker_error", message: "ECONNREFUSED" });
  });

  test("liveRequireErrorResponse maps each variant to the right HTTP code", async () => {
    expect(liveRequireErrorResponse({ ok: true })).toBeNull();
    expect(
      (liveRequireErrorResponse({ ok: false, reason: "no_container" }) as Response).status,
    ).toBe(400);
    expect((liveRequireErrorResponse({ ok: false, reason: "missing" }) as Response).status).toBe(
      409,
    );
    expect(
      (
        liveRequireErrorResponse({
          ok: false,
          reason: "not_running",
          live_status: "error",
        }) as Response
      ).status,
    ).toBe(409);
    expect(
      (liveRequireErrorResponse({ ok: false, reason: "docker_error", message: "x" }) as Response)
        .status,
    ).toBe(503);
  });
});
