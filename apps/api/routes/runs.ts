import db from "../db";

const PAGE_SIZE = 20;

export function handleRuns(req: Request, url: URL): Response | null {
  // /api/projects/:id/runs
  const projectMatch = url.pathname.match(/^\/api\/projects\/(\d+)\/runs$/);
  if (projectMatch && req.method === "GET") {
    const projectId = Number(projectMatch[1]);
    const page = Number(url.searchParams.get("page") || "1");
    const offset = (page - 1) * PAGE_SIZE;

    const rows = db
      .query(
        `SELECT r.*, c.name as cron_name
         FROM runs r
         LEFT JOIN crons c ON c.id = r.cron_id
         WHERE r.project_id = ?
         ORDER BY r.started_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(projectId, PAGE_SIZE, offset);

    const { total } = db
      .query("SELECT COUNT(*) as total FROM runs WHERE project_id = ?")
      .get(projectId) as { total: number };

    return Response.json({ runs: rows, total });
  }

  // /api/projects/:id/build-output
  const buildMatch = url.pathname.match(/^\/api\/projects\/(\d+)\/build-output$/);
  if (buildMatch && req.method === "GET") {
    const projectId = Number(buildMatch[1]);
    const row = db
      .query(
        `SELECT * FROM runs
         WHERE project_id = ? AND cron_id IS NULL
         ORDER BY started_at DESC
         LIMIT 1`,
      )
      .get(projectId);

    if (!row) return Response.json({ output: null });
    return Response.json(row);
  }

  // /api/runs/:id
  const runMatch = url.pathname.match(/^\/api\/runs\/(\d+)$/);
  if (runMatch && req.method === "GET") {
    const id = Number(runMatch[1]);
    const row = db
      .query(
        `SELECT r.*, c.name as cron_name
         FROM runs r
         LEFT JOIN crons c ON c.id = r.cron_id
         WHERE r.id = ?`,
      )
      .get(id);

    if (!row) return new Response("Not found", { status: 404 });
    return Response.json(row);
  }

  return null;
}
