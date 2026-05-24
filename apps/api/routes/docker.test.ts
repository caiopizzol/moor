// Integration tests for #34 Phase A: timeout_ms validation on POST /exec.
// Runs against an in-memory SQLite DB. Tests that exercise the "accept" path
// inject a fake container_id so the request gets past the route's running-
// container guard; the Docker call itself then fails at the engine layer
// (which is fine — we're only verifying validation, not real exec behavior).
// Live timing and kill semantics are verified manually post-deploy.

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
    // #73: container_id is null → "no_container" → 400 with more
    // specific wording. Previously this was "Container is not running"
    // for both no-container and not-running cases; #73 distinguishes
    // them (no_container=400, not_running=409 with live_status).
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Project has no container; build/start it first");
  });
});

// #74: deterministic tests. The flaky "missing or docker_error
// depending on env" test was replaced with three layers:
//  - getContainerLogs() called with an injected mock fetcher
//  - buildLogsResponse() called with each fetch-result variant
//  - the route end-to-end for no_container (no Docker required)
//
// This locks down the contract without depending on a real Docker
// daemon and exercises every state path explicitly.

const { getContainerLogs, parseDockerLogsBody } = await import("../docker");
const { buildLogsResponse } = await import("./docker");

function dockerFrame(text: string): Uint8Array {
  const bytes = new TextEncoder().encode(text);
  // Allocate on a plain ArrayBuffer (not SharedArrayBuffer) so the
  // resulting Uint8Array's `.buffer` is accepted by `new Response()`
  // and Blob() across lib versions.
  const buf = new ArrayBuffer(8 + bytes.length);
  const frame = new Uint8Array(buf);
  frame[0] = 1; // stdout
  frame[4] = (bytes.length >>> 24) & 0xff;
  frame[5] = (bytes.length >>> 16) & 0xff;
  frame[6] = (bytes.length >>> 8) & 0xff;
  frame[7] = bytes.length & 0xff;
  frame.set(bytes, 8);
  return frame;
}

describe("#74 parseDockerLogsBody (pure)", () => {
  test("strips 8-byte frame headers and the Docker timestamp prefix", () => {
    const body = dockerFrame("2026-05-24T10:00:00.000000000Z hello world\n");
    const parsed = parseDockerLogsBody(body, 0);
    expect(parsed.logs).toBe("hello world\n");
    expect(parsed.lastTimestamp).toBe(Math.ceil(new Date("2026-05-24T10:00:00Z").getTime() / 1000));
  });

  test("lines without a timestamp are passed through unchanged", () => {
    const body = dockerFrame("no timestamp\n");
    const parsed = parseDockerLogsBody(body, 42);
    expect(parsed.logs).toBe("no timestamp\n");
    expect(parsed.lastTimestamp).toBe(42); // since fallback
  });
});

describe("#74 getContainerLogs union — each branch via injected fetcher", () => {
  test("ok branch returns { ok: true, logs, lastTimestamp }", async () => {
    const fetcher = async () => {
      const frame = dockerFrame("2026-05-24T10:00:00.000000000Z line\n");
      // Blob accepts BlobPart, but the Uint8Array generic in some TS
      // libs is ArrayBufferLike which isn't strictly BodyInit-compatible.
      // Cast through unknown to satisfy the type without changing
      // runtime behavior — Bun/Node accept Uint8Array at runtime.
      return new Response(frame as unknown as BodyInit, { status: 200 });
    };
    const result = await getContainerLogs("any", {}, fetcher);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.logs).toBe("line\n");
      expect(result.lastTimestamp).toBeGreaterThan(0);
    }
  });

  test("404 from Docker → { ok: false, kind: 'missing' }", async () => {
    const fetcher = async () => new Response("no such container", { status: 404 });
    const result = await getContainerLogs("any", {}, fetcher);
    expect(result).toEqual({ ok: false, kind: "missing" });
  });

  test("500 from Docker → { ok: false, kind: 'error', message }", async () => {
    const fetcher = async () => new Response("daemon busted", { status: 500 });
    const result = await getContainerLogs("any", {}, fetcher);
    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === "error") {
      expect(result.message).toContain("500");
      expect(result.message).toContain("daemon busted");
    }
  });

  test("fetcher throws (socket unreachable) → { ok: false, kind: 'error', message }", async () => {
    const fetcher = async () => {
      throw new Error("ECONNREFUSED");
    };
    const result = await getContainerLogs("any", {}, fetcher);
    expect(result).toEqual({ ok: false, kind: "error", message: "ECONNREFUSED" });
  });
});

describe("#74 buildLogsResponse — each state branch", () => {
  test("ok + live_status='running' → state='ok', 200", () => {
    const r = buildLogsResponse({ ok: true, logs: "hi", lastTimestamp: 5 }, "running");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ logs: "hi", lastTimestamp: 5, state: "ok" });
  });

  test("ok + live_status='stopped' → state='exited' (logs from a dead container)", () => {
    const r = buildLogsResponse({ ok: true, logs: "last words", lastTimestamp: 7 }, "stopped");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ logs: "last words", lastTimestamp: 7, state: "exited" });
  });

  test("ok + live_status='error' → state='exited' (non-running counts as exited)", () => {
    const r = buildLogsResponse({ ok: true, logs: "x", lastTimestamp: 0 }, "error");
    expect((r.body as { state: string }).state).toBe("exited");
  });

  test("ok + live_status=null (reconciler hasn't ticked) → state='ok'", () => {
    const r = buildLogsResponse({ ok: true, logs: "x", lastTimestamp: 0 }, null);
    expect((r.body as { state: string }).state).toBe("ok");
  });

  test("missing → state='missing', 200, empty logs", () => {
    const r = buildLogsResponse({ ok: false, kind: "missing" }, "running");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ logs: "", lastTimestamp: 0, state: "missing" });
  });

  test("docker_error → state='docker_error', 502, error message preserved", () => {
    const r = buildLogsResponse({ ok: false, kind: "error", message: "ECONNREFUSED" }, "running");
    expect(r.status).toBe(502);
    expect(r.body).toEqual({
      logs: "",
      lastTimestamp: 0,
      state: "docker_error",
      error: "ECONNREFUSED",
    });
  });
});

describe("#74 GET /api/projects/:id/logs — end-to-end no_container path", () => {
  beforeEach(() => {
    db.query("DELETE FROM projects").run();
  });

  test("no container_id → state='no_container', empty logs, 200 (no Docker call)", async () => {
    const p = db
      .query("INSERT INTO projects (name, status) VALUES ('a', 'stopped') RETURNING id")
      .get() as { id: number };
    const res = await call("GET", `/api/projects/${p.id}/logs`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { logs: string; lastTimestamp: number; state: string };
    expect(body).toEqual({ logs: "", lastTimestamp: 0, state: "no_container" });
  });
});
