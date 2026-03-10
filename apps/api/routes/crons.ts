import { runCron } from "../cron";
import db from "../db";

export async function handleCrons(req: Request, url: URL): Promise<Response | null> {
  // Project-scoped: /api/projects/:id/crons
  const projectMatch = url.pathname.match(/^\/api\/projects\/(\d+)\/crons$/);
  if (projectMatch) {
    const projectId = Number(projectMatch[1]);

    if (req.method === "GET") {
      const rows = db
        .query("SELECT * FROM crons WHERE project_id = ? ORDER BY name")
        .all(projectId);
      return Response.json(rows);
    }

    if (req.method === "POST") {
      return await handleCreate(req, projectId);
    }
  }

  // Cron-scoped: /api/crons/:id
  const cronMatch = url.pathname.match(/^\/api\/crons\/(\d+)$/);
  if (cronMatch) {
    const id = Number(cronMatch[1]);

    if (req.method === "PUT") return await handleUpdate(req, id);
    if (req.method === "DELETE") {
      db.query("DELETE FROM crons WHERE id = ?").run(id);
      return new Response(null, { status: 204 });
    }
  }

  // Trigger: /api/crons/:id/run
  const runMatch = url.pathname.match(/^\/api\/crons\/(\d+)\/run$/);
  if (runMatch && req.method === "POST") {
    const id = Number(runMatch[1]);
    const cron = db.query("SELECT * FROM crons WHERE id = ?").get(id) as {
      id: number;
      project_id: number;
      name: string;
      schedule: string;
      command: string;
      enabled: number;
    } | null;
    if (!cron) return new Response("Cron not found", { status: 404 });

    const project = db
      .query("SELECT id, container_id, status FROM projects WHERE id = ?")
      .get(cron.project_id) as { id: number; container_id: string | null; status: string } | null;
    if (!project || project.status !== "running" || !project.container_id) {
      return Response.json({ error: "Container is not running" }, { status: 400 });
    }

    runCron(cron, project.container_id);
    return Response.json({ ok: true });
  }

  return null;
}

async function handleCreate(req: Request, projectId: number): Promise<Response> {
  const { name, schedule, command } = await req.json();
  if (!name || !schedule || !command) {
    return new Response("name, schedule, and command are required", { status: 400 });
  }

  const row = db
    .query(
      "INSERT INTO crons (project_id, name, schedule, command) VALUES (?, ?, ?, ?) RETURNING *",
    )
    .get(projectId, name, schedule, command);

  return Response.json(row, { status: 201 });
}

async function handleUpdate(req: Request, id: number): Promise<Response> {
  const body = await req.json();
  const fields: string[] = [];
  const values: (string | number)[] = [];

  for (const key of ["name", "schedule", "command", "enabled"]) {
    if (key in body) {
      fields.push(`${key} = ?`);
      values.push(body[key]);
    }
  }

  if (fields.length === 0) return new Response("No fields to update", { status: 400 });

  values.push(id);
  const row = db
    .query(`UPDATE crons SET ${fields.join(", ")} WHERE id = ? RETURNING *`)
    .get(...values);
  if (!row) return new Response("Not found", { status: 404 });

  return Response.json(row);
}
