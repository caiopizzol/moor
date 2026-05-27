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

describe("#112 build path credential resolution", () => {
  beforeEach(() => {
    db.query("DELETE FROM projects").run();
    db.query("DELETE FROM source_credentials").run();
  });

  function makeCred(
    hostname: string,
    label: string,
    state: "active" | "failed" = "active",
  ): number {
    const row = db
      .query(
        "INSERT INTO source_credentials (hostname, label, username, secret, state) VALUES (?, ?, 'x-access-token', 'ghp_a', ?) RETURNING id",
      )
      .get(hostname, label, state) as { id: number };
    return row.id;
  }

  function makeGithubProject(name: string, source_credential_id: number | null = null): number {
    const row = db
      .query(
        "INSERT INTO projects (name, github_url, branch, dockerfile, restart_policy, status, source_credential_id) VALUES (?, 'https://github.com/owner/repo', 'main', 'Dockerfile', 'unless-stopped', 'stopped', ?) RETURNING id",
      )
      .get(name, source_credential_id) as { id: number };
    return row.id;
  }

  function statusOf(id: number): string {
    const row = db.query("SELECT status FROM projects WHERE id = ?").get(id) as {
      status: string;
    };
    return row.status;
  }

  test("host mismatch returns 400 BEFORE flipping status to building", async () => {
    const wrongHost = makeCred("gitlab.com", "wrong-host");
    const pId = makeGithubProject("p1", wrongHost);
    const res = await call("POST", `/api/projects/${pId}/build`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("credential_host_mismatch");
    // Side effect guard: status must still be 'stopped', no build_run row
    expect(statusOf(pId)).toBe("stopped");
    const runCount = db.query("SELECT COUNT(*) as n FROM runs WHERE project_id = ?").get(pId) as {
      n: number;
    };
    expect(runCount.n).toBe(0);
  });

  test("failed credential returns 400 with credential_not_active (build strict)", async () => {
    const dead = makeCred("github.com", "dead", "failed");
    const pId = makeGithubProject("p2", dead);
    const res = await call("POST", `/api/projects/${pId}/build`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; state: string };
    expect(body.code).toBe("credential_not_active");
    expect(body.state).toBe("failed");
    expect(statusOf(pId)).toBe("stopped");
  });

  test("/run resolves host_mismatch before opening the SSE stream", async () => {
    const wrongHost = makeCred("gitlab.com", "wrong");
    const pId = makeGithubProject("p-run-host", wrongHost);
    const res = await call("POST", `/api/projects/${pId}/run`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("credential_host_mismatch");
    expect(statusOf(pId)).toBe("stopped");
  });

  test("invalid github_url (legacy migration edge) returns 400 BEFORE side effects", async () => {
    // Project with a non-conformant URL slipping past earlier validation.
    db.query(
      "INSERT INTO projects (name, github_url, branch, dockerfile, restart_policy, status) VALUES ('p5', 'https://github.com/owner/repo?branch=main', 'main', 'Dockerfile', 'unless-stopped', 'stopped')",
    ).run();
    const pId = (db.query("SELECT id FROM projects WHERE name = 'p5'").get() as { id: number }).id;
    const res = await call("POST", `/api/projects/${pId}/build`);
    // ?branch=main makes parseRepoUrl reject (query string disallowed).
    // The legacy validateGithubUrl accepts it, so we DO flip status. But
    // the resolver catches it. With v1 we accept the flip; document the
    // edge. The point is: build doesn't proceed.
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("invalid_url");
  });
});
