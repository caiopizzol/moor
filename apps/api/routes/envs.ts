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
    return Response.json(listProjectEnvs(projectId));
  }

  if (req.method === "PUT") {
    return Response.json(replaceProjectEnvs(projectId, await req.json()));
  }

  return null;
}

export function replaceProjectEnvs(
  projectId: number,
  vars: Array<{ key: string; value: string }>,
): Array<{ id: number; project_id: number; key: string; value: string }> {
  // Use db.transaction for safe concurrent access
  const updateEnvs = db.transaction(() => {
    db.query("DELETE FROM env_vars WHERE project_id = ?").run(projectId);
    const insert = db.query("INSERT INTO env_vars (project_id, key, value) VALUES (?, ?, ?)");
    for (const { key, value } of vars) {
      if (key.trim()) insert.run(projectId, key.trim(), value);
    }
  });
  updateEnvs();

  return listProjectEnvs(projectId);
}

export function listProjectEnvs(
  projectId: number,
): Array<{ id: number; project_id: number; key: string; value: string }> {
  return db
    .query("SELECT * FROM env_vars WHERE project_id = ? ORDER BY key")
    .all(projectId) as Array<{ id: number; project_id: number; key: string; value: string }>;
}
