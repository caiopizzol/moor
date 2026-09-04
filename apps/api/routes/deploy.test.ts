process.env.MOOR_DB_PATH = ":memory:";

import { beforeEach, describe, expect, test } from "bun:test";
import type { Project, ProjectActionResult } from "../deploy";

const { default: db } = await import("../db");
const { acquireProjectNameLifecycleLock, withProjectLifecycleLock } = await import("../deploy");
const { handleDeploy } = await import("./deploy");

function sseStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

async function responseText(response: Response): Promise<string> {
  return await response.text();
}

async function call(
  body: Record<string, unknown>,
  overrides: Parameters<typeof handleDeploy>[2] = {
    requireNotDraining: () => null,
    runProject: async () => {
      throw new Error("runProject was not expected");
    },
  },
): Promise<Response> {
  const req = new Request("http://localhost/api/deploy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const response = await handleDeploy(req, new URL(req.url), overrides);
  if (!response) throw new Error("handleDeploy returned null");
  return response;
}

describe("POST /api/deploy", () => {
  beforeEach(() => {
    db.query("DELETE FROM projects").run();
    db.query("DELETE FROM drain_state").run();
  });

  test("creates project configuration and runs it through one request", async () => {
    const runCalls: Array<{ project: Project; noCache: boolean }> = [];
    const req = new Request("http://localhost/api/deploy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "app",
        docker_image: "nginx:alpine",
        env: { NODE_ENV: "production" },
        volumes: [{ name: "data", target: "/data" }],
        files: [{ path: "/etc/app.conf", content: "enabled=true", mode: "0600" }],
        run: true,
      }),
    });

    const response = await handleDeploy(req, new URL(req.url), {
      requireNotDraining: () => null,
      runProject: async (project: Project, input: { noCache: boolean }) => {
        runCalls.push({ project, noCache: input.noCache });
        return {
          kind: "stream",
          stream: sseStream(
            'event: log\ndata: "pull complete\\n"\n\nevent: done\ndata: "Container started"\n\n',
          ),
        } satisfies ProjectActionResult;
      },
    });

    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toContain("text/event-stream");
    const body = await responseText(response as Response);
    expect(body).toContain(
      `event: deploy\ndata: {"action":"created","project_id":${runCalls[0].project.id},"project_name":"app","env_keys":["NODE_ENV"],"run":true,"env_changes_pending_restart":false}`,
    );
    expect(body).toContain('event: log\ndata: "pull complete\\n"');
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0].noCache).toBe(false);
    expect(runCalls[0].project.docker_image).toBe("nginx:alpine");

    const env = db.query("SELECT key, value FROM env_vars").get() as {
      key: string;
      value: string;
    };
    expect(env).toEqual({ key: "NODE_ENV", value: "production" });
    expect(db.query("SELECT name, target FROM project_volumes").get()).toEqual({
      name: "data",
      target: "/data",
    });
    expect(db.query("SELECT path, content, mode FROM project_files").get()).toEqual({
      path: "/etc/app.conf",
      content: "enabled=true",
      mode: "0600",
    });
  });

  test("rejects drain before creating or updating configuration", async () => {
    const response = await call(
      { name: "app", docker_image: "nginx:alpine" },
      {
        requireNotDraining: () =>
          Response.json({ error: "moor is draining", reason: "upgrade" }, { status: 503 }),
        runProject: async () => {
          throw new Error("runProject was not expected");
        },
      },
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "moor is draining", reason: "upgrade" });
    expect(db.query("SELECT id FROM projects").get()).toBeNull();
  });

  test("validates the source and nested configuration before creating a project", async () => {
    const badSource = await call({
      name: "app",
      github_url: "https://github.com/owner/repo/tree/main",
      run: false,
    });
    expect(badSource.status).toBe(400);
    expect((await badSource.json()) as { error: string }).toEqual({
      error:
        'github_url must point to /owner/repo (with optional .git); got "/owner/repo/tree/main"',
    });

    const badVolume = await call({
      name: "app",
      docker_image: "nginx:alpine",
      volumes: [{ name: "data", target: "/proc/1" }],
      run: false,
    });
    expect(badVolume.status).toBe(400);

    const badFile = await call({
      name: "app",
      docker_image: "nginx:alpine",
      files: [{ path: "relative", content: "x" }],
      run: false,
    });
    expect(badFile.status).toBe(400);
    expect(db.query("SELECT id FROM projects").get()).toBeNull();
  });

  test("rejects conflicting volumes within one request before creating a project", async () => {
    const response = await call({
      name: "app",
      docker_image: "nginx:alpine",
      volumes: [
        { name: "data", target: "/shared" },
        { name: "cache", target: "/shared" },
      ],
      run: false,
    });

    expect(response.status).toBe(400);
    expect(db.query("SELECT id FROM projects").get()).toBeNull();
    expect(db.query("SELECT id FROM project_volumes").get()).toBeNull();
  });

  test("validates project metadata types before creating a project", async () => {
    const invalidMetadata = [
      { domain: 123 },
      { domain_port: "3000" },
      { restart_policy: "sometimes" },
      { branch: 42 },
    ];

    for (const metadata of invalidMetadata) {
      const response = await call({
        name: "app",
        docker_image: "nginx:alpine",
        run: false,
        ...metadata,
      });
      expect(response.status).toBe(400);
      expect(db.query("SELECT id FROM projects").get()).toBeNull();
    }
  });

  test("requires update_existing before changing an existing project", async () => {
    db.query(
      "INSERT INTO projects (name, docker_image, branch) VALUES ('app', 'nginx:old', 'main')",
    ).run();

    const response = await call({
      name: "app",
      docker_image: "nginx:new",
      run: false,
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Project "app" already exists. Pass update_existing: true to update it.',
    });
    expect(db.query("SELECT docker_image FROM projects WHERE name = 'app'").get()).toEqual({
      docker_image: "nginx:old",
    });
  });

  test("updates metadata through the same SSE protocol without Docker work when run is false", async () => {
    db.query(
      "INSERT INTO projects (name, docker_image, branch, status) VALUES ('app', 'nginx:old', 'main', 'running')",
    ).run();

    const response = await call({
      name: "app",
      docker_image: "nginx:new",
      env: { FEATURE: "on" },
      run: false,
      update_existing: true,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const body = await response.text();
    const project = db.query("SELECT id FROM projects WHERE name = 'app'").get() as { id: number };
    expect(body).toContain(
      `event: deploy\ndata: {"action":"updated","project_id":${project.id},"project_name":"app","env_keys":["FEATURE"],"run":false,"env_changes_pending_restart":true}`,
    );
    expect(body).toContain('event: done\ndata: "Configuration saved"');
    expect(db.query("SELECT docker_image FROM projects WHERE name = 'app'").get()).toEqual({
      docker_image: "nginx:new",
    });
  });

  test("merges deploy env values into an existing project", async () => {
    const project = db
      .query(
        "INSERT INTO projects (name, docker_image, branch) VALUES ('app', 'nginx:alpine', 'main') RETURNING id",
      )
      .get() as { id: number };
    db.query("INSERT INTO env_vars (project_id, key, value) VALUES (?, 'KEEP', 'existing')").run(
      project.id,
    );

    const response = await call({
      name: "app",
      env: { ADD: "new" },
      run: false,
      update_existing: true,
    });

    expect(response.status).toBe(200);
    expect(
      db.query("SELECT key, value FROM env_vars WHERE project_id = ? ORDER BY key").all(project.id),
    ).toEqual([
      { key: "ADD", value: "new" },
      { key: "KEEP", value: "existing" },
    ]);
  });

  test("serializes deploys that concurrently create the same project name", async () => {
    const releaseBarrier = await acquireProjectNameLifecycleLock("same-name");
    let markFirstAtLock: () => void = () => {};
    let markSecondAtLock: () => void = () => {};
    const firstAtLock = new Promise<void>((resolve) => {
      markFirstAtLock = resolve;
    });
    const secondAtLock = new Promise<void>((resolve) => {
      markSecondAtLock = resolve;
    });
    const deps = (markAtLock: () => void): Parameters<typeof handleDeploy>[2] => {
      let drainCalls = 0;
      return {
        requireNotDraining: () => {
          drainCalls += 1;
          if (drainCalls === 1) markAtLock();
          return null;
        },
        runProject: async () => ({ kind: "json", body: { message: "started" } }),
      };
    };

    const first = call(
      {
        name: "same-name",
        docker_image: "nginx:first",
        env: { ORDER: "first" },
        update_existing: true,
      },
      deps(markFirstAtLock),
    );
    await firstAtLock;
    const second = call(
      {
        name: "same-name",
        docker_image: "nginx:second",
        env: { ORDER: "second" },
        update_existing: true,
      },
      deps(markSecondAtLock),
    );
    await secondAtLock;
    const projectBeforeRelease = db.query("SELECT id FROM projects WHERE name = 'same-name'").get();
    releaseBarrier();

    const responses = await Promise.all([first, second]);
    expect(responses.map(({ status }) => status)).toEqual([200, 200]);
    const project = db
      .query("SELECT id, docker_image FROM projects WHERE name = 'same-name'")
      .get() as { id: number; docker_image: string };
    expect(projectBeforeRelease).toBeNull();
    expect(project.docker_image).toBe("nginx:second");
    expect(
      db.query("SELECT value FROM env_vars WHERE project_id = ? AND key = 'ORDER'").get(project.id),
    ).toEqual({ value: "second" });
  });

  test("tags pre-stream run failures without dropping their structured fields", async () => {
    const response = await call(
      {
        name: "app",
        github_url: "https://github.com/owner/app",
      },
      {
        requireNotDraining: () => null,
        runProject: async () => ({
          kind: "json",
          status: 400,
          body: {
            ok: false,
            code: "credential_not_active",
            source_credential_id: 42,
            state: "failed",
          },
        }),
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      code: "credential_not_active",
      source_credential_id: 42,
      state: "failed",
      error:
        '[run] {"ok":false,"code":"credential_not_active","source_credential_id":42,"state":"failed"}',
    });
  });

  test("cancelling the deploy response cancels the wrapped run stream", async () => {
    let cancelledWith: unknown;
    let markComplete: () => void = () => {};
    const completion = new Promise<void>((resolve) => {
      markComplete = resolve;
    });
    const inner = new ReadableStream<Uint8Array>({
      cancel(reason) {
        cancelledWith = reason;
      },
    });
    const response = await call(
      { name: "app", docker_image: "nginx:alpine" },
      {
        requireNotDraining: () => null,
        runProject: async () => ({ kind: "stream", stream: inner, completion }),
      },
    );
    const reader = response.body?.getReader();
    if (!reader) throw new Error("deploy response had no body");

    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toStartWith("event: deploy\n");
    const cancellation = reader.cancel("client disconnected");

    const project = db.query("SELECT id FROM projects WHERE name = 'app'").get() as { id: number };
    let competingLifecycleRan = false;
    const competing = withProjectLifecycleLock(project.id, () => {
      competingLifecycleRan = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(cancelledWith).toBe("client disconnected");
    expect(competingLifecycleRan).toBe(false);

    markComplete();
    await cancellation;
    await competing;
    expect(competingLifecycleRan).toBe(true);
  });

  test("rechecks drain after waiting for an active project lifecycle", async () => {
    const project = db
      .query(
        "INSERT INTO projects (name, docker_image, branch) VALUES ('app', 'nginx:old', 'main') RETURNING id",
      )
      .get() as { id: number };
    let releaseActive: () => void = () => {};
    let markActive: () => void = () => {};
    const activeGate = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });
    const activeStarted = new Promise<void>((resolve) => {
      markActive = resolve;
    });
    const active = withProjectLifecycleLock(project.id, async () => {
      markActive();
      await activeGate;
    });
    await activeStarted;

    let drainCalls = 0;
    let draining = false;
    let markFirstDrain: () => void = () => {};
    const firstDrain = new Promise<void>((resolve) => {
      markFirstDrain = resolve;
    });
    const pending = call(
      {
        name: "app",
        docker_image: "nginx:new",
        update_existing: true,
      },
      {
        requireNotDraining: () => {
          drainCalls += 1;
          markFirstDrain();
          return draining ? Response.json({ error: "moor is draining" }, { status: 503 }) : null;
        },
        runProject: async () => ({ kind: "json", body: { message: "started" } }),
      },
    );
    await firstDrain;
    draining = true;
    releaseActive();
    await active;

    const response = await pending;
    expect(response.status).toBe(503);
    expect(drainCalls).toBe(2);
    expect(db.query("SELECT docker_image FROM projects WHERE id = ?").get(project.id)).toEqual({
      docker_image: "nginx:old",
    });
  });

  test("holds the project lifecycle lock until the deploy stream finishes", async () => {
    const project = db
      .query(
        "INSERT INTO projects (name, docker_image, branch) VALUES ('app', 'nginx:old', 'main') RETURNING id",
      )
      .get() as { id: number };
    let closeRunStream: () => void = () => {};
    let markRunStarted: () => void = () => {};
    const runStarted = new Promise<void>((resolve) => {
      markRunStarted = resolve;
    });
    const response = await call(
      {
        name: "app",
        docker_image: "nginx:new",
        update_existing: true,
      },
      {
        requireNotDraining: () => null,
        runProject: async () => ({
          kind: "stream",
          stream: new ReadableStream<Uint8Array>({
            start(controller) {
              closeRunStream = () => controller.close();
              markRunStarted();
            },
          }),
        }),
      },
    );
    await runStarted;

    let competingLifecycleRan = false;
    const competing = withProjectLifecycleLock(project.id, () => {
      competingLifecycleRan = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(competingLifecycleRan).toBe(false);

    closeRunStream();
    await response.text();
    await competing;
    expect(competingLifecycleRan).toBe(true);
  });

  test("accepts an identical existing volume but rejects target drift", async () => {
    await call({
      name: "app",
      docker_image: "nginx:alpine",
      volumes: [{ name: "data", target: "/data" }],
      run: false,
    });

    const idempotent = await call({
      name: "app",
      volumes: [{ name: "data", target: "/data" }],
      run: false,
      update_existing: true,
    });
    expect(idempotent.status).toBe(200);

    const conflict = await call({
      name: "app",
      volumes: [{ name: "data", target: "/other" }],
      run: false,
      update_existing: true,
    });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()) as { error: string }).toEqual({
      error:
        '[volumes] conflict adding data: existing target "/data" differs from requested "/other". moor_deploy does not change mount targets; use moor_volume_remove + moor_volume_add explicitly.',
    });
  });
});
