// Integration tests for #34 Phase A: timeout_ms validation on POST /exec.
// Runs against an in-memory SQLite DB. We never actually reach Docker because
// the handler short-circuits on a missing/non-running container; that's the
// boundary we want to test for input validation. The actual exec timing is
// verified manually post-deploy.

process.env.MOOR_DB_PATH = ":memory:";

import { beforeEach, describe, expect, test } from "bun:test";

const { default: db } = await import("../db");
const { handleDocker } = await import("./docker");

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const res = await handleDocker(req, new URL(req.url));
  if (!res) throw new Error(`handleDocker returned null for ${method} ${path}`);
  return res;
}

function insertProject(name: string): { id: number } {
  return db
    .query(
      "INSERT INTO projects (name, docker_image, branch, dockerfile, restart_policy, status, container_id) VALUES (?, 'alpine:latest', 'main', 'Dockerfile', 'unless-stopped', 'running', 'fake-container-id') RETURNING id",
    )
    .get(name) as { id: number };
}

describe("#34 POST /exec timeout_ms validation", () => {
  beforeEach(() => {
    db.query("DELETE FROM projects").run();
  });

  test("rejects timeout_ms below the minimum", async () => {
    const p = insertProject("a");
    const res = await call("POST", `/api/projects/${p.id}/exec`, {
      command: "echo hi",
      timeout_ms: 500,
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("timeout_ms must be an integer between");
  });

  test("rejects timeout_ms above the maximum", async () => {
    const p = insertProject("b");
    const res = await call("POST", `/api/projects/${p.id}/exec`, {
      command: "echo hi",
      timeout_ms: 3_600_001,
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("timeout_ms must be an integer between");
  });

  test("rejects non-integer timeout_ms", async () => {
    const p = insertProject("c");
    const res = await call("POST", `/api/projects/${p.id}/exec`, {
      command: "echo hi",
      timeout_ms: 5000.5,
    });
    expect(res.status).toBe(400);
  });

  test("rejects negative timeout_ms", async () => {
    const p = insertProject("d");
    const res = await call("POST", `/api/projects/${p.id}/exec`, {
      command: "echo hi",
      timeout_ms: -1,
    });
    expect(res.status).toBe(400);
  });

  test("accepts a valid timeout_ms and reaches the Docker layer", async () => {
    // Container ID is fake; the request reaches dockerFetch and fails there.
    // We only care that input validation passed (we got past the 400 path).
    const p = insertProject("e");
    const res = await call("POST", `/api/projects/${p.id}/exec`, {
      command: "echo hi",
      timeout_ms: 30_000,
    });
    expect(res.status).not.toBe(400);
  });

  test("accepts missing timeout_ms and uses the default", async () => {
    const p = insertProject("f");
    const res = await call("POST", `/api/projects/${p.id}/exec`, {
      command: "echo hi",
    });
    expect(res.status).not.toBe(400);
  });

  test("rejects requests with no command (existing behavior preserved)", async () => {
    const p = insertProject("g");
    const res = await call("POST", `/api/projects/${p.id}/exec`, { timeout_ms: 30_000 });
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Missing command");
  });

  test("returns 400 when the project's container is not running, regardless of timeout_ms", async () => {
    db.query(
      "INSERT INTO projects (name, docker_image, branch, dockerfile, restart_policy, status) VALUES ('stopped-p', 'alpine:latest', 'main', 'Dockerfile', 'unless-stopped', 'stopped')",
    ).run();
    const row = db.query("SELECT id FROM projects WHERE name = 'stopped-p'").get() as {
      id: number;
    };
    const res = await call("POST", `/api/projects/${row.id}/exec`, {
      command: "echo hi",
      timeout_ms: 30_000,
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Container is not running");
  });
});
