// Integration test for the #35 volumes route. Runs against an in-memory
// SQLite DB so the dev/prod file is never touched. The handler reaches
// the schema (validations, uniqueness, cascade) but never touches Docker —
// the dockerized purge path lives in projects route and is verified live.

process.env.MOOR_DB_PATH = ":memory:";

import { beforeEach, describe, expect, test } from "bun:test";

const { default: db } = await import("../db");
const { handleVolumes, getProjectVolumes, collectProjectVolumeDockerNames } = await import(
  "./volumes"
);

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const res = await handleVolumes(req, new URL(req.url));
  if (!res) throw new Error(`handleVolumes returned null for ${method} ${path}`);
  return res;
}

function makeProject(name: string): number {
  const row = db.query("INSERT INTO projects (name) VALUES (?) RETURNING id").get(name) as {
    id: number;
  };
  return row.id;
}

describe("#35 volume routes", () => {
  beforeEach(() => {
    db.query("DELETE FROM project_volumes").run();
    db.query("DELETE FROM projects").run();
  });

  test("POST creates a volume with generated docker_name", async () => {
    const pid = makeProject("app");
    const res = await call("POST", `/api/projects/${pid}/volumes`, {
      name: "data",
      target: "/var/lib/postgresql/data",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: number;
      name: string;
      target: string;
      docker_name: string;
    };
    expect(body.name).toBe("data");
    expect(body.target).toBe("/var/lib/postgresql/data");
    expect(body.docker_name).toBe("moor-app-data");
  });

  test("GET lists volumes for the project, sorted by name", async () => {
    const pid = makeProject("app");
    await call("POST", `/api/projects/${pid}/volumes`, { name: "z-data", target: "/data2" });
    await call("POST", `/api/projects/${pid}/volumes`, { name: "a-data", target: "/data1" });
    const res = await call("GET", `/api/projects/${pid}/volumes`);
    const rows = (await res.json()) as Array<{ name: string }>;
    expect(rows.map((r) => r.name)).toEqual(["a-data", "z-data"]);
  });

  test("POST rejects invalid name and target", async () => {
    const pid = makeProject("app");
    const badName = await call("POST", `/api/projects/${pid}/volumes`, {
      name: "_starts-bad",
      target: "/x",
    });
    expect(badName.status).toBe(400);

    const badTarget = await call("POST", `/api/projects/${pid}/volumes`, {
      name: "ok",
      target: "/proc/1",
    });
    expect(badTarget.status).toBe(400);
    expect(await badTarget.text()).toContain("/proc/");
  });

  test("POST 409 on duplicate name within a project", async () => {
    const pid = makeProject("app");
    await call("POST", `/api/projects/${pid}/volumes`, { name: "data", target: "/x" });
    const res = await call("POST", `/api/projects/${pid}/volumes`, { name: "data", target: "/y" });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("already has a volume named");
  });

  test("POST 409 on duplicate target within a project", async () => {
    const pid = makeProject("app");
    await call("POST", `/api/projects/${pid}/volumes`, { name: "a", target: "/data" });
    const res = await call("POST", `/api/projects/${pid}/volumes`, { name: "b", target: "/data" });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("already has a volume mounted at");
  });

  test("two different projects can have the same logical name (different docker_name)", async () => {
    const p1 = makeProject("app1");
    const p2 = makeProject("app2");
    const r1 = await call("POST", `/api/projects/${p1}/volumes`, { name: "data", target: "/d" });
    const r2 = await call("POST", `/api/projects/${p2}/volumes`, { name: "data", target: "/d" });
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(((await r1.json()) as { docker_name: string }).docker_name).toBe("moor-app1-data");
    expect(((await r2.json()) as { docker_name: string }).docker_name).toBe("moor-app2-data");
  });

  test("DELETE removes the mount config only (preserves docker_name in response)", async () => {
    const pid = makeProject("app");
    const created = (await (
      await call("POST", `/api/projects/${pid}/volumes`, { name: "data", target: "/d" })
    ).json()) as { id: number; docker_name: string };
    const res = await call("DELETE", `/api/projects/${pid}/volumes/${created.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; docker_name: string; message: string };
    expect(body.docker_name).toBe(created.docker_name);
    expect(body.message).toContain("preserved");
    // Row is gone from the DB
    const after = db.query("SELECT id FROM project_volumes WHERE id = ?").get(created.id);
    expect(after).toBeNull();
  });

  test("DELETE 404 when volume is not on this project", async () => {
    const p1 = makeProject("app1");
    const p2 = makeProject("app2");
    const created = (await (
      await call("POST", `/api/projects/${p1}/volumes`, { name: "data", target: "/d" })
    ).json()) as { id: number };
    // Try deleting via the wrong project
    const res = await call("DELETE", `/api/projects/${p2}/volumes/${created.id}`);
    expect(res.status).toBe(404);
  });

  test("getProjectVolumes returns the mount list for createAndStartContainer", async () => {
    const pid = makeProject("app");
    await call("POST", `/api/projects/${pid}/volumes`, { name: "data", target: "/d1" });
    await call("POST", `/api/projects/${pid}/volumes`, { name: "logs", target: "/d2" });
    const mounts = getProjectVolumes(pid);
    expect(mounts).toHaveLength(2);
    expect(mounts.map((m) => m.docker_name).sort()).toEqual(["moor-app-data", "moor-app-logs"]);
  });

  test("collectProjectVolumeDockerNames captures names before CASCADE wipes them", async () => {
    const pid = makeProject("app");
    await call("POST", `/api/projects/${pid}/volumes`, { name: "v1", target: "/a" });
    await call("POST", `/api/projects/${pid}/volumes`, { name: "v2", target: "/b" });
    const names = collectProjectVolumeDockerNames(pid);
    expect(names.sort()).toEqual(["moor-app-v1", "moor-app-v2"]);
    // Deleting the project cascades; collecting after returns empty
    db.query("DELETE FROM projects WHERE id = ?").run(pid);
    expect(collectProjectVolumeDockerNames(pid)).toEqual([]);
  });
});
