import db from "../db";
import { stopContainer } from "../docker";

export async function handleProjects(req: Request, url: URL): Promise<Response | null> {
  const match = url.pathname.match(/^\/api\/projects(?:\/(\d+))?$/);
  if (!match) return null;

  const id = match[1] ? Number(match[1]) : null;
  console.log(`[projects] ${req.method} /api/projects${id ? `/${id}` : ""}`);

  if (req.method === "GET" && !id) {
    const rows = db.query("SELECT * FROM projects ORDER BY name").all();
    console.log(`[projects] listing ${(rows as unknown[]).length} projects`);
    return Response.json(rows);
  }

  if (req.method === "GET" && id) {
    const row = db.query("SELECT * FROM projects WHERE id = ?").get(id);
    if (!row) return new Response("Not found", { status: 404 });
    return Response.json(row);
  }

  if (req.method === "POST" && !id) {
    return await handleCreate(req);
  }

  if (req.method === "PUT" && id) {
    return await handleUpdate(req, id);
  }

  if (req.method === "DELETE" && id) {
    // Stop and remove the container before deleting the project
    const project = db.query("SELECT container_id FROM projects WHERE id = ?").get(id) as {
      container_id: string | null;
    } | null;
    if (project?.container_id) {
      try {
        await stopContainer(project.container_id);
      } catch {
        // best effort — container may already be gone
      }
    }
    db.query("DELETE FROM projects WHERE id = ?").run(id);
    return new Response(null, { status: 204 });
  }

  return null;
}

async function handleCreate(req: Request): Promise<Response> {
  const body = await req.json();
  const { name, github_url, branch, dockerfile } = body;
  console.log(
    `[projects] create: name=${name} github_url=${github_url} branch=${branch || "main"} dockerfile=${dockerfile || "Dockerfile"}`,
  );
  if (!name) return new Response("name is required", { status: 400 });
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) {
    return new Response("name must be alphanumeric (hyphens and underscores allowed)", {
      status: 400,
    });
  }

  const existing = db.query("SELECT id FROM projects WHERE name = ?").get(name);
  if (existing) {
    return new Response("A project with this name already exists", { status: 409 });
  }

  const result = db
    .query(
      "INSERT INTO projects (name, github_url, branch, dockerfile) VALUES (?, ?, ?, ?) RETURNING *",
    )
    .get(name, github_url ?? null, branch ?? "main", dockerfile ?? "Dockerfile");

  console.log("[projects] created:", JSON.stringify(result));
  return Response.json(result, { status: 201 });
}

async function handleUpdate(req: Request, id: number): Promise<Response> {
  const body = await req.json();
  const fields: string[] = [];
  const values: (string | number)[] = [];

  for (const key of ["name", "github_url", "branch", "dockerfile"]) {
    if (key in body) {
      fields.push(`${key} = ?`);
      values.push(body[key]);
    }
  }

  if (fields.length === 0) return new Response("No fields to update", { status: 400 });

  if ("name" in body && body.name) {
    const existing = db
      .query("SELECT id FROM projects WHERE name = ? AND id != ?")
      .get(body.name, id);
    if (existing) {
      return new Response("A project with this name already exists", { status: 409 });
    }
  }

  values.push(id);
  const row = db
    .query(`UPDATE projects SET ${fields.join(", ")} WHERE id = ? RETURNING *`)
    .get(...values);

  if (!row) return new Response("Not found", { status: 404 });
  return Response.json(row);
}
