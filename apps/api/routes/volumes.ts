import db from "../db";
import {
  buildDockerName,
  validateDockerName,
  validateVolumeName,
  validateVolumeTarget,
} from "../volumes";

type Project = { id: number; name: string };

type VolumeRow = {
  id: number;
  project_id: number;
  name: string;
  target: string;
  docker_name: string;
};

export async function handleVolumes(req: Request, url: URL): Promise<Response | null> {
  // GET /api/projects/:id/volumes — list
  // POST /api/projects/:id/volumes — create
  const projectMatch = url.pathname.match(/^\/api\/projects\/(\d+)\/volumes$/);
  if (projectMatch) {
    const projectId = Number(projectMatch[1]);
    const project = db
      .query("SELECT id, name FROM projects WHERE id = ?")
      .get(projectId) as Project | null;
    if (!project) return new Response("Project not found", { status: 404 });

    if (req.method === "GET") {
      const rows = db
        .query(
          "SELECT id, project_id, name, target, docker_name FROM project_volumes WHERE project_id = ? ORDER BY name",
        )
        .all(project.id);
      return Response.json(rows);
    }

    if (req.method === "POST") {
      const body = (await req.json()) as { name?: string; target?: string };

      const nameErr = validateVolumeName(body.name);
      if (nameErr) return new Response(nameErr, { status: 400 });
      const targetErr = validateVolumeTarget(body.target);
      if (targetErr) return new Response(targetErr, { status: 400 });
      // Validation above narrowed these, but TS still sees them as
      // string|undefined; the asserts make the SQL bindings type-check.
      const volName = body.name as string;
      const volTarget = body.target as string;

      const dockerName = buildDockerName(project.name, volName);
      const dockerErr = validateDockerName(dockerName);
      if (dockerErr) return new Response(dockerErr, { status: 400 });

      try {
        const inserted = db
          .query(
            "INSERT INTO project_volumes (project_id, name, target, docker_name) VALUES (?, ?, ?, ?) RETURNING id, project_id, name, target, docker_name",
          )
          .get(project.id, volName, volTarget, dockerName) as VolumeRow;
        return Response.json(inserted, { status: 201 });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("UNIQUE")) {
          if (msg.includes("project_volumes.docker_name")) {
            return new Response(
              `A Docker volume named "${dockerName}" already exists for another project. Use a different volume name.`,
              { status: 409 },
            );
          }
          if (msg.includes("project_volumes.name") || msg.includes("project_id, name")) {
            return new Response(`This project already has a volume named "${body.name}"`, {
              status: 409,
            });
          }
          if (msg.includes("project_volumes.target") || msg.includes("project_id, target")) {
            return new Response(`This project already has a volume mounted at "${body.target}"`, {
              status: 409,
            });
          }
          return new Response(`Volume conflict: ${msg}`, { status: 409 });
        }
        throw e;
      }
    }

    return null;
  }

  // DELETE /api/projects/:id/volumes/:vid — remove mount config
  // The underlying Docker volume is intentionally preserved; deletion of data
  // is reserved for project delete with purge_volumes=true. See #35.
  const volumeMatch = url.pathname.match(/^\/api\/projects\/(\d+)\/volumes\/(\d+)$/);
  if (volumeMatch && req.method === "DELETE") {
    const projectId = Number(volumeMatch[1]);
    const volumeId = Number(volumeMatch[2]);
    const row = db
      .query("SELECT id, docker_name FROM project_volumes WHERE id = ? AND project_id = ?")
      .get(volumeId, projectId) as { id: number; docker_name: string } | null;
    if (!row) return new Response("Volume not found", { status: 404 });

    db.query("DELETE FROM project_volumes WHERE id = ?").run(row.id);
    return Response.json({
      ok: true,
      docker_name: row.docker_name,
      message: `Removed mount config. Docker volume "${row.docker_name}" preserved; use 'docker volume rm ${row.docker_name}' to delete the data.`,
    });
  }

  return null;
}

/** Used by createAndStartContainer callers: pull the mount list for a project
 *  so the container is recreated with the right volume bindings. */
export function getProjectVolumes(
  projectId: number,
): Array<{ docker_name: string; target: string }> {
  return db
    .query("SELECT docker_name, target FROM project_volumes WHERE project_id = ?")
    .all(projectId) as Array<{ docker_name: string; target: string }>;
}

/** Collect Docker volume names BEFORE the project row is deleted (CASCADE wipes
 *  the metadata). Caller is responsible for actually deleting the Docker
 *  volumes after the project row is gone. */
export function collectProjectVolumeDockerNames(projectId: number): string[] {
  const rows = db
    .query("SELECT docker_name FROM project_volumes WHERE project_id = ?")
    .all(projectId) as Array<{ docker_name: string }>;
  return rows.map((r) => r.docker_name);
}
