import { syncCaddyRoutes } from "../caddy";
import db from "../db";
import { removeContainer, stopContainer } from "../docker";

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
    const project = db.query("SELECT container_id, domain FROM projects WHERE id = ?").get(id) as {
      container_id: string | null;
      domain: string | null;
    } | null;
    if (project?.container_id) {
      try {
        await stopContainer(project.container_id);
        await removeContainer(project.container_id);
      } catch {
        // best effort — container may already be gone
      }
    }
    const hadDomain = !!project?.domain;
    db.query("DELETE FROM projects WHERE id = ?").run(id);
    if (hadDomain) {
      syncCaddyRoutes().catch((e) => console.error("[projects] caddy sync failed:", e));
    }
    return new Response(null, { status: 204 });
  }

  return null;
}

async function handleCreate(req: Request): Promise<Response> {
  const body = await req.json();
  const {
    name,
    github_url,
    docker_image,
    branch,
    dockerfile,
    domain,
    domain_port,
    restart_policy,
  } = body;
  console.log(
    `[projects] create: name=${name} github_url=${github_url} docker_image=${docker_image} branch=${branch || "main"} dockerfile=${dockerfile || "Dockerfile"} domain=${domain || ""} domain_port=${domain_port || ""}`,
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

  const validPolicies = ["no", "on-failure", "always", "unless-stopped"];
  const policy = validPolicies.includes(restart_policy) ? restart_policy : "unless-stopped";

  const result = db
    .query(
      "INSERT INTO projects (name, github_url, docker_image, branch, dockerfile, domain, domain_port, restart_policy) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *",
    )
    .get(
      name,
      docker_image ? null : (github_url ?? null),
      docker_image ?? null,
      branch ?? "main",
      dockerfile ?? "Dockerfile",
      domain?.trim() || null,
      domain_port ?? null,
      policy,
    );

  if (domain?.trim()) {
    syncCaddyRoutes().catch((e) => console.error("[projects] caddy sync failed:", e));
  }

  console.log("[projects] created:", JSON.stringify(result));
  return Response.json(result, { status: 201 });
}

async function handleUpdate(req: Request, id: number): Promise<Response> {
  const body = await req.json();
  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  const validPolicies = ["no", "on-failure", "always", "unless-stopped"];

  for (const key of [
    "name",
    "github_url",
    "docker_image",
    "branch",
    "dockerfile",
    "domain",
    "domain_port",
    "restart_policy",
  ]) {
    if (key in body) {
      fields.push(`${key} = ?`);
      if (key === "domain") {
        values.push(body[key]?.trim() || null);
      } else if (key === "restart_policy") {
        values.push(validPolicies.includes(body[key]) ? body[key] : "unless-stopped");
      } else {
        values.push(body[key]);
      }
    }
  }

  // When switching source type, clear the other
  if ("docker_image" in body && body.docker_image) {
    if (!fields.some((f) => f.startsWith("github_url"))) {
      fields.push("github_url = ?");
      values.push(null);
    }
  } else if ("github_url" in body && body.github_url) {
    if (!fields.some((f) => f.startsWith("docker_image"))) {
      fields.push("docker_image = ?");
      values.push(null);
    }
  }

  // Clear domain_port when domain is removed
  if ("domain" in body && !body.domain?.trim()) {
    if (!fields.some((f) => f.startsWith("domain_port"))) {
      fields.push("domain_port = ?");
      values.push(null);
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

  // Sync Caddy if domain-related fields changed
  if ("domain" in body || "domain_port" in body) {
    syncCaddyRoutes().catch((e) => console.error("[projects] caddy sync failed:", e));
  }

  return Response.json(row);
}
