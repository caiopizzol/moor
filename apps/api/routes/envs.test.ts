process.env.MOOR_DB_PATH = ":memory:";

import { beforeEach, describe, expect, test } from "bun:test";
import type { Project, ProjectActionResult, RestartProjectInput } from "../deploy";

const { default: db } = await import("../db");
const { handleEnvs } = await import("./envs");

function insertProject(status: "running" | "stopped" = "stopped"): Project {
  return db
    .query(
      "INSERT INTO projects (name, docker_image, image_tag, branch, dockerfile, restart_policy, status, container_id) " +
        "VALUES ('app', 'nginx:alpine', 'nginx:alpine', 'main', 'Dockerfile', 'unless-stopped', ?, ?) RETURNING *",
    )
    .get(status, status === "running" ? "container-id" : null) as Project;
}

async function call(
  projectId: number,
  body: unknown,
  restart: (
    project: Project,
    input: RestartProjectInput,
  ) => Promise<ProjectActionResult> = async () => {
    throw new Error("restart was not expected");
  },
): Promise<Response> {
  const request = new Request(`http://localhost/api/projects/${projectId}/envs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const response = await handleEnvs(request, new URL(request.url), { restartProject: restart });
  if (!response) throw new Error("handleEnvs returned null");
  return response;
}

function envs(projectId: number): Array<{ key: string; value: string }> {
  return db
    .query("SELECT key, value FROM env_vars WHERE project_id = ? ORDER BY key")
    .all(projectId) as Array<{ key: string; value: string }>;
}

describe("POST /api/projects/:id/envs", () => {
  beforeEach(() => {
    db.query("DELETE FROM env_vars").run();
    db.query("DELETE FROM projects").run();
  });

  test("merges values without restarting a stopped project", async () => {
    const project = insertProject();
    db.query("INSERT INTO env_vars (project_id, key, value) VALUES (?, 'A', '1')").run(project.id);

    const response = await call(project.id, { vars: { B: "2" } });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ updated_keys: ["B"], restarted: false });
    expect(envs(project.id)).toEqual([
      { key: "A", value: "1" },
      { key: "B", value: "2" },
    ]);
  });

  test("restarts a running project after merging values", async () => {
    const project = insertProject("running");
    const restarted: number[] = [];

    const response = await call(
      project.id,
      { vars: { B: "2", A: "new" } },
      async (target, input) => {
        restarted.push(target.id);
        expect(input).toEqual({ lifecycleLockHeld: true });
        expect(envs(target.id)).toEqual([
          { key: "A", value: "new" },
          { key: "B", value: "2" },
        ]);
        return { kind: "json", body: { message: "Container restarted" } };
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ updated_keys: ["A", "B"], restarted: true });
    expect(restarted).toEqual([project.id]);
  });

  test("serializes PUT and DELETE mutations across a running-project restart", async () => {
    const project = insertProject("running");
    db.query("INSERT INTO env_vars (project_id, key, value) VALUES (?, 'A', '1')").run(project.id);
    let markRestartStarted: () => void = () => {};
    let finishRestart: () => void = () => {};
    const restartStarted = new Promise<void>((resolve) => {
      markRestartStarted = resolve;
    });
    const restartGate = new Promise<void>((resolve) => {
      finishRestart = resolve;
    });
    let envsDuringRestart: Array<{ key: string; value: string }> = [];

    const postResponse = call(project.id, { vars: { B: "2" } }, async () => {
      markRestartStarted();
      await restartGate;
      envsDuringRestart = envs(project.id);
      return { kind: "json", body: { message: "Container restarted" } };
    });
    await restartStarted;

    const putUrl = new URL(`http://localhost/api/projects/${project.id}/envs`);
    const putResponse = handleEnvs(
      { method: "PUT", json: async () => [{ key: "C", value: "3" }] } as Request,
      putUrl,
    );
    const deleteUrl = new URL(`http://localhost/api/projects/${project.id}/envs/A`);
    const deleteResponse = handleEnvs(new Request(deleteUrl, { method: "DELETE" }), deleteUrl);
    await Promise.resolve();

    finishRestart();
    expect((await postResponse).status).toBe(200);
    expect((await putResponse)?.status).toBe(200);
    expect((await deleteResponse)?.status).toBe(204);
    expect(envsDuringRestart).toEqual([
      { key: "A", value: "1" },
      { key: "B", value: "2" },
    ]);
  });

  test("reports that values were saved when restart fails", async () => {
    const project = insertProject("running");

    const response = await call(project.id, { vars: { B: "2" } }, async () => ({
      kind: "response",
      response: Response.json({ error: "moor is draining" }, { status: 503 }),
    }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Environment variables were updated, but restart failed: moor is draining",
      env_updated: true,
      updated_keys: ["B"],
    });
    expect(envs(project.id)).toEqual([{ key: "B", value: "2" }]);
  });

  test("rejects invalid input without changing values", async () => {
    const project = insertProject();
    db.query("INSERT INTO env_vars (project_id, key, value) VALUES (?, 'A', '1')").run(project.id);

    for (const body of [{}, { vars: {} }, { vars: { A: 2 } }, { vars: { " ": "x" } }]) {
      const response = await call(project.id, body);
      expect(response.status).toBe(400);
    }
    expect(envs(project.id)).toEqual([{ key: "A", value: "1" }]);
  });

  test("returns 404 without writing values for a missing project", async () => {
    const response = await call(999, { vars: { A: "1" } });

    expect(response.status).toBe(404);
    expect(envs(999)).toEqual([]);
  });

  test("returns 400 for malformed JSON", async () => {
    const project = insertProject();
    const request = new Request(`http://localhost/api/projects/${project.id}/envs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });

    const response = await handleEnvs(request, new URL(request.url));
    expect(response?.status).toBe(400);
    expect(await response?.json()).toEqual({ error: "invalid JSON body" });
  });
});
