import db from "../db";

export async function handleEnvs(req: Request, url: URL): Promise<Response | null> {
  // /api/projects/:id/envs/:key
  const keyMatch = url.pathname.match(/^\/api\/projects\/(\d+)\/envs\/(.+)$/);
  if (keyMatch && req.method === "DELETE") {
    const projectId = Number(keyMatch[1]);
    const key = decodeURIComponent(keyMatch[2]);
    db.query("DELETE FROM env_vars WHERE project_id = ? AND key = ?").run(projectId, key);
    return new Response(null, { status: 204 });
  }

  // /api/projects/:id/envs
  const match = url.pathname.match(/^\/api\/projects\/(\d+)\/envs$/);
  if (!match) return null;

  const projectId = Number(match[1]);

  if (req.method === "GET") {
    const rows = db
      .query("SELECT * FROM env_vars WHERE project_id = ? ORDER BY key")
      .all(projectId);
    return Response.json(rows);
  }

  if (req.method === "PUT") {
    return await handleBulkSet(req, projectId);
  }

  return null;
}

async function handleBulkSet(req: Request, projectId: number): Promise<Response> {
  const vars: { key: string; value: string }[] = await req.json();

  db.exec("BEGIN");
  try {
    db.query("DELETE FROM env_vars WHERE project_id = ?").run(projectId);
    const insert = db.query("INSERT INTO env_vars (project_id, key, value) VALUES (?, ?, ?)");
    for (const { key, value } of vars) {
      if (key.trim()) insert.run(projectId, key.trim(), value);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }

  const rows = db.query("SELECT * FROM env_vars WHERE project_id = ? ORDER BY key").all(projectId);
  return Response.json(rows);
}
