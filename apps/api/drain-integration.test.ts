// Integration tests for #79 drain gates. Verifies each route in the
// drain refusal scope returns 503 with the documented body when drain
// is active, and returns its normal response when drain is off. Runs
// against an in-memory SQLite. Routes that talk to Docker would fail
// at the daemon layer with "fake-container-id" — but the drain gate
// fires BEFORE the Docker call, so the 503 path needs no Docker mock.

process.env.MOOR_DB_PATH = ":memory:";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const { default: db } = await import("./db");
const { disableDrain, enableDrain } = await import("./drain");
const { handleDocker } = await import("./routes/docker");
const { handleExec: handleExecRoute } = await import("./routes/exec");
const { handleCrons } = await import("./routes/crons");
const { handleServer } = await import("./routes/server");
const { upgradeTerminal } = await import("./terminal");

async function call(
  handler: (req: Request, url: URL) => Promise<Response | null>,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const res = await handler(req, new URL(req.url));
  if (!res) throw new Error(`handler returned null for ${method} ${path}`);
  return res;
}

function insertProject(name: string): { id: number } {
  return db
    .query(
      "INSERT INTO projects (name, docker_image, branch, dockerfile, restart_policy, status, container_id) VALUES (?, 'alpine:latest', 'main', 'Dockerfile', 'unless-stopped', 'running', 'fake-container-id') RETURNING id",
    )
    .get(name) as { id: number };
}

function insertCron(projectId: number): { id: number } {
  return db
    .query(
      "INSERT INTO crons (project_id, name, schedule, command) VALUES (?, 'c', '* * * * *', 'echo') RETURNING id",
    )
    .get(projectId) as { id: number };
}

async function expectDrain503(res: Response): Promise<void> {
  expect(res.status).toBe(503);
  const body = (await res.json()) as {
    error: string;
    reason: string | null;
    expires_at: string | null;
    hint: string;
  };
  expect(body.error).toBe("moor is draining");
  expect(body.reason).toBe("upgrading");
  expect(body.expires_at).not.toBeNull();
  expect(body.hint).toContain("moor_drain_disable");
}

describe("#79 drain gates on action routes", () => {
  beforeEach(() => {
    db.query("DELETE FROM crons").run();
    db.query("DELETE FROM projects").run();
    db.query("DELETE FROM drain_state").run();
  });

  afterEach(() => {
    disableDrain();
  });

  test("POST /api/projects/:id/run returns 503 when drained", async () => {
    const p = insertProject("p");
    enableDrain({ reason: "upgrading", ttl_minutes: 30 });
    const res = await call(handleDocker, "POST", `/api/projects/${p.id}/run`);
    await expectDrain503(res);
  });

  test("POST /api/projects/:id/build returns 503 when drained", async () => {
    const p = insertProject("p");
    enableDrain({ reason: "upgrading", ttl_minutes: 30 });
    const res = await call(handleDocker, "POST", `/api/projects/${p.id}/build`);
    await expectDrain503(res);
  });

  test("POST /api/projects/:id/start returns 503 when drained", async () => {
    const p = insertProject("p");
    enableDrain({ reason: "upgrading", ttl_minutes: 30 });
    const res = await call(handleDocker, "POST", `/api/projects/${p.id}/start`);
    await expectDrain503(res);
  });

  test("POST /api/projects/:id/exec returns 503 when drained (sync exec)", async () => {
    const p = insertProject("p");
    enableDrain({ reason: "upgrading", ttl_minutes: 30 });
    const res = await call(handleDocker, "POST", `/api/projects/${p.id}/exec`, {
      command: "echo hi",
    });
    await expectDrain503(res);
  });

  test("POST /api/projects/:id/exec/async returns 503 when drained", async () => {
    const p = insertProject("p");
    enableDrain({ reason: "upgrading", ttl_minutes: 30 });
    const res = await call(handleExecRoute, "POST", `/api/projects/${p.id}/exec/async`, {
      command: "echo hi",
    });
    await expectDrain503(res);
  });

  test("POST /api/crons/:id/run returns 503 when drained", async () => {
    const p = insertProject("p");
    const c = insertCron(p.id);
    enableDrain({ reason: "upgrading", ttl_minutes: 30 });
    const res = await call(handleCrons, "POST", `/api/crons/${c.id}/run`);
    await expectDrain503(res);
  });

  test("POST /api/projects/:id/stop is NOT gated by drain (stop is fine during drain)", async () => {
    const p = insertProject("p");
    enableDrain({ reason: "upgrading", ttl_minutes: 30 });
    // stop will try to talk to Docker with fake-container-id and fail.
    // The test only asserts it's NOT a drain 503 — anything else is OK.
    const res = await call(handleDocker, "POST", `/api/projects/${p.id}/stop`);
    expect(res.status).not.toBe(503);
  });

  test("GET /api/projects/:id/logs is NOT gated by drain (logs are read-only)", async () => {
    const p = insertProject("p");
    enableDrain({ reason: "upgrading", ttl_minutes: 30 });
    const res = await call(handleDocker, "GET", `/api/projects/${p.id}/logs`);
    expect(res.status).not.toBe(503);
  });

  test("upgradeTerminal returns 503 when drained, WITHOUT calling server.upgrade", async () => {
    const p = insertProject("p");
    enableDrain({ reason: "upgrading", ttl_minutes: 30 });
    let upgradeCalled = false;
    const fakeServer = {
      upgrade: () => {
        upgradeCalled = true;
        return true;
      },
      // Other Bun.serve members aren't touched by the drain path.
    } as unknown as ReturnType<typeof Bun.serve>;
    const req = new Request(`http://localhost/api/projects/${p.id}/terminal`);
    const res = await upgradeTerminal(req, fakeServer);
    expect(upgradeCalled).toBe(false);
    expect(res).not.toBe(true);
    if (res === true) throw new Error("unreachable");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; hint: string };
    expect(body.error).toBe("moor is draining");
    expect(body.hint).toContain("moor_drain_disable");
  });
});

describe("#79 drain server routes (GET /api/server/drain)", () => {
  beforeEach(() => {
    db.query("DELETE FROM drain_state").run();
    db.query("DELETE FROM runs").run();
    db.query("DELETE FROM exec_runs").run();
    db.query("DELETE FROM crons").run();
    db.query("DELETE FROM projects").run();
  });

  test("status returns disabled state + zero counts when drain is off", async () => {
    const res = await call(handleServer, "GET", "/api/server/drain");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      state: { enabled: boolean };
      active_work: { builds_in_flight: number };
    };
    expect(body.state.enabled).toBe(false);
    expect(body.active_work.builds_in_flight).toBe(0);
  });

  test("enable writes the row and returns it", async () => {
    const res = await call(handleServer, "POST", "/api/server/drain/enable", {
      reason: "test",
      ttl_minutes: 30,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      state: { enabled: boolean; reason: string; expires_at: string };
    };
    expect(body.state.enabled).toBe(true);
    expect(body.state.reason).toBe("test");
    expect(body.state.expires_at).not.toBeNull();
  });

  test("disable clears the row", async () => {
    enableDrain({ reason: "test", ttl_minutes: 30 });
    const res = await call(handleServer, "POST", "/api/server/drain/disable", {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: { enabled: boolean } };
    expect(body.state.enabled).toBe(false);
  });

  test("enable with no body uses defaults (default TTL, no reason)", async () => {
    // Some callers may POST with empty body; routes/server.ts catches the
    // json parse error and falls back to {}.
    const req = new Request("http://localhost/api/server/drain/enable", { method: "POST" });
    const res = await handleServer(req, new URL(req.url));
    expect(res).not.toBeNull();
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as {
      state: { enabled: boolean; reason: string | null; expires_at: string };
    };
    expect(body.state.enabled).toBe(true);
    expect(body.state.reason).toBeNull();
    expect(body.state.expires_at).not.toBeNull();
  });
});
