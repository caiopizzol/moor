import db from "../db";
import { autoDetectPorts, getProjectPorts } from "../ports";

export async function handlePorts(req: Request, url: URL): Promise<Response | null> {
  const match = url.pathname.match(/^\/api\/projects\/(\d+)\/ports$/);
  if (!match) return null;

  const projectId = Number(match[1]);

  if (req.method === "GET") {
    let rows = getProjectPorts(projectId);

    // Auto-detect ports from image if none stored yet
    if (rows.length === 0) {
      const project = db.query("SELECT image_tag FROM projects WHERE id = ?").get(projectId) as {
        image_tag: string | null;
      } | null;
      if (project?.image_tag) {
        try {
          rows = await autoDetectPorts(projectId, project.image_tag);
        } catch {
          // Race condition or no available ports — return empty
        }
      }
    }

    return Response.json(rows);
  }

  return null;
}
