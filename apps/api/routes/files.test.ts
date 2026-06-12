// Integration test for the declarative file-injection route. Runs against an
// in-memory SQLite DB so the dev/prod file is never touched. The handler reaches
// the schema (validation, upsert-by-path, cascade) but never touches Docker —
// the archive PUT into a live container is exercised in docker-container-extras.test.ts.

process.env.MOOR_DB_PATH = ":memory:";

import { beforeEach, describe, expect, test } from "bun:test";

const { default: db } = await import("../db");
const { handleFiles, getProjectFiles, getResolvedProjectFiles } = await import("./files");

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const res = await handleFiles(req, new URL(req.url));
  if (!res) throw new Error(`handleFiles returned null for ${method} ${path}`);
  return res;
}

function makeProject(name: string): number {
  const row = db.query("INSERT INTO projects (name) VALUES (?) RETURNING id").get(name) as {
    id: number;
  };
  return row.id;
}

type PresentedFile = {
  id: number;
  project_id: number;
  path: string;
  mode: string;
  source: string;
  env_ref: string | null;
};

describe("file injection routes", () => {
  beforeEach(() => {
    db.query("DELETE FROM project_files").run();
    db.query("DELETE FROM env_vars").run();
    db.query("DELETE FROM projects").run();
  });

  test("POST creates an inline file and never echoes raw content", async () => {
    const pid = makeProject("app");
    const res = await call("POST", `/api/projects/${pid}/files`, {
      path: "/etc/app/config.yml",
      content: "secret: true",
      mode: "0600",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as PresentedFile & { content?: string };
    expect(body.path).toBe("/etc/app/config.yml");
    expect(body.mode).toBe("0600");
    expect(body.source).toBe("inline");
    expect(body.env_ref).toBeNull();
    expect(body.content).toBeUndefined(); // raw content stays out of responses
    // ...but it IS persisted for injection.
    const stored = db.query("SELECT content FROM project_files WHERE id = ?").get(body.id) as {
      content: string;
    };
    expect(stored.content).toBe("secret: true");
  });

  test("POST defaults the mode to 0644 when omitted", async () => {
    const pid = makeProject("app");
    const res = await call("POST", `/api/projects/${pid}/files`, {
      path: "/a.txt",
      content: "x",
    });
    expect(((await res.json()) as PresentedFile).mode).toBe("0644");
  });

  test("POST with env_ref records source=env, no inline content", async () => {
    const pid = makeProject("app");
    const res = await call("POST", `/api/projects/${pid}/files`, {
      path: "/etc/ssl/key.pem",
      env_ref: "TLS_KEY",
      mode: "0600",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as PresentedFile;
    expect(body.source).toBe("env");
    expect(body.env_ref).toBe("TLS_KEY");
  });

  test("POST is an upsert by path: re-posting the same path updates content/mode and returns 200", async () => {
    const pid = makeProject("app");
    const first = await call("POST", `/api/projects/${pid}/files`, {
      path: "/etc/cert.pem",
      content: "v1",
      mode: "0644",
    });
    expect(first.status).toBe(201);
    const second = await call("POST", `/api/projects/${pid}/files`, {
      path: "/etc/cert.pem",
      content: "v2",
      mode: "0600",
    });
    expect(second.status).toBe(200);
    // Exactly one row for this path; content + mode updated in place.
    const rows = db
      .query("SELECT content, mode FROM project_files WHERE project_id = ? AND path = ?")
      .all(pid, "/etc/cert.pem") as Array<{ content: string; mode: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe("v2");
    expect(rows[0].mode).toBe("0600");
  });

  test("GET lists files for the project, sorted by path", async () => {
    const pid = makeProject("app");
    await call("POST", `/api/projects/${pid}/files`, { path: "/z.txt", content: "z" });
    await call("POST", `/api/projects/${pid}/files`, { path: "/a.txt", content: "a" });
    const rows = (await (
      await call("GET", `/api/projects/${pid}/files`)
    ).json()) as PresentedFile[];
    expect(rows.map((r) => r.path)).toEqual(["/a.txt", "/z.txt"]);
  });

  test("POST rejects bad path, bad mode, and bad content/env_ref combinations", async () => {
    const pid = makeProject("app");
    expect(
      (await call("POST", `/api/projects/${pid}/files`, { path: "rel", content: "x" })).status,
    ).toBe(400);
    expect(
      (await call("POST", `/api/projects/${pid}/files`, { path: "/proc/1", content: "x" })).status,
    ).toBe(400);
    expect(
      (await call("POST", `/api/projects/${pid}/files`, { path: "/a", content: "x", mode: "999" }))
        .status,
    ).toBe(400);
    // neither content nor env_ref
    expect((await call("POST", `/api/projects/${pid}/files`, { path: "/a" })).status).toBe(400);
    // both content and env_ref
    expect(
      (await call("POST", `/api/projects/${pid}/files`, { path: "/a", content: "x", env_ref: "E" }))
        .status,
    ).toBe(400);
  });

  test("POST 404 when the project does not exist", async () => {
    const res = await call("POST", "/api/projects/99999/files", { path: "/a", content: "x" });
    expect(res.status).toBe(404);
  });

  test("DELETE removes a file spec; 404 when it is not on this project", async () => {
    const p1 = makeProject("app1");
    const p2 = makeProject("app2");
    const created = (await (
      await call("POST", `/api/projects/${p1}/files`, { path: "/a", content: "x" })
    ).json()) as PresentedFile;
    // Wrong project → 404
    expect((await call("DELETE", `/api/projects/${p2}/files/${created.id}`)).status).toBe(404);
    // Right project → 200 and the row is gone
    const ok = await call("DELETE", `/api/projects/${p1}/files/${created.id}`);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { ok: boolean }).ok).toBe(true);
    expect(db.query("SELECT id FROM project_files WHERE id = ?").get(created.id)).toBeNull();
  });

  test("getProjectFiles returns raw specs; getResolvedProjectFiles resolves env_ref + numeric mode", async () => {
    const pid = makeProject("app");
    await call("POST", `/api/projects/${pid}/files`, {
      path: "/a.conf",
      content: "inline",
      mode: "0644",
    });
    await call("POST", `/api/projects/${pid}/files`, {
      path: "/b.key",
      env_ref: "B_KEY",
      mode: "0600",
    });

    const specs = getProjectFiles(pid);
    expect(specs).toHaveLength(2);

    const resolved = getResolvedProjectFiles(pid, [{ key: "B_KEY", value: "PEM" }]);
    const byPath = Object.fromEntries(resolved.map((f) => [f.path, f]));
    expect(byPath["/a.conf"]).toEqual({ path: "/a.conf", content: "inline", mode: 0o644 });
    expect(byPath["/b.key"]).toEqual({ path: "/b.key", content: "PEM", mode: 0o600 });
  });

  test("getResolvedProjectFiles throws when an env_ref is unset on the project", () => {
    const pid = makeProject("app");
    db.query(
      "INSERT INTO project_files (project_id, path, content, env_ref, mode) VALUES (?, '/k', NULL, 'MISSING', '0600')",
    ).run(pid);
    expect(() => getResolvedProjectFiles(pid, [])).toThrow('references env var "MISSING"');
  });

  test("ON DELETE CASCADE: deleting the project removes its file specs", async () => {
    const pid = makeProject("app");
    await call("POST", `/api/projects/${pid}/files`, { path: "/a", content: "x" });
    db.query("DELETE FROM projects WHERE id = ?").run(pid);
    expect(getProjectFiles(pid)).toEqual([]);
  });
});
