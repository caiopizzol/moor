import db from "../db";

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

  for (const key of [
    "name",
    "github_url",
    "branch",
    "dockerfile",
    "image_tag",
    "container_id",
    "status",
  ]) {
    if (key in body) {
      fields.push(`${key} = ?`);
      values.push(body[key]);
    }
  }

  if (fields.length === 0) return new Response("No fields to update", { status: 400 });

  values.push(id);
  const row = db
    .query(`UPDATE projects SET ${fields.join(", ")} WHERE id = ? RETURNING *`)
    .get(...values);

  if (!row) return new Response("Not found", { status: 404 });
  return Response.json(row);
}
