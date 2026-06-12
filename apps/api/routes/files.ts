import {
  DEFAULT_FILE_MODE,
  type FileSpec,
  type ResolvedFile,
  resolveFiles,
  validateFileContent,
  validateFileMode,
  validateFilePath,
} from "../container-config";
import db from "../db";

type Project = { id: number; name: string };

type FileRow = {
  id: number;
  project_id: number;
  path: string;
  content: string | null;
  env_ref: string | null;
  mode: string;
};

/** Shape returned to API clients: the destination + how content is sourced, but
 *  never the raw inline body (kept out of list responses; it may be large and,
 *  for env-sourced files, the secret lives in the env store, not here). */
function presentFile(row: FileRow) {
  return {
    id: row.id,
    project_id: row.project_id,
    path: row.path,
    mode: row.mode,
    source: row.env_ref ? "env" : "inline",
    env_ref: row.env_ref,
  };
}

export async function handleFiles(req: Request, url: URL): Promise<Response | null> {
  // GET  /api/projects/:id/files — list
  // POST /api/projects/:id/files — create
  const projectMatch = url.pathname.match(/^\/api\/projects\/(\d+)\/files$/);
  if (projectMatch) {
    const projectId = Number(projectMatch[1]);
    const project = db
      .query("SELECT id, name FROM projects WHERE id = ?")
      .get(projectId) as Project | null;
    if (!project) return new Response("Project not found", { status: 404 });

    if (req.method === "GET") {
      const rows = db
        .query(
          "SELECT id, project_id, path, content, env_ref, mode FROM project_files WHERE project_id = ? ORDER BY path",
        )
        .all(project.id) as FileRow[];
      return Response.json(rows.map(presentFile));
    }

    if (req.method === "POST") {
      const body = (await req.json()) as {
        path?: string;
        content?: string;
        env_ref?: string;
        mode?: string;
      };

      const pathErr = validateFilePath(body.path);
      if (pathErr) return new Response(pathErr, { status: 400 });
      const contentErr = validateFileContent(body.content, body.env_ref);
      if (contentErr) return new Response(contentErr, { status: 400 });
      const modeErr = validateFileMode(body.mode);
      if (modeErr) return new Response(modeErr, { status: 400 });

      const filePath = body.path as string;
      const mode = body.mode ?? DEFAULT_FILE_MODE;
      const content = body.content ?? null;
      const envRef = body.env_ref ?? null;

      // Upsert by (project_id, path): a file spec is identified by its
      // destination, and content is mutable (e.g. rotating a TLS cert), so
      // re-POSTing the same path updates intent rather than 409-ing — the
      // behavior the UNIQUE(project_id, path) constraint was added to express
      // (see db.ts). Idempotent re-adds also let moor_deploy carry files
      // without a remove+add dance on every redeploy. 201 on create, 200 on
      // update so callers can still tell the two apart.
      const existing = db
        .query("SELECT id FROM project_files WHERE project_id = ? AND path = ?")
        .get(project.id, filePath) as { id: number } | null;
      const row = db
        .query(
          `INSERT INTO project_files (project_id, path, content, env_ref, mode)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(project_id, path)
           DO UPDATE SET content = excluded.content, env_ref = excluded.env_ref, mode = excluded.mode
           RETURNING id, project_id, path, content, env_ref, mode`,
        )
        .get(project.id, filePath, content, envRef, mode) as FileRow;
      return Response.json(presentFile(row), { status: existing ? 200 : 201 });
    }

    return null;
  }

  // DELETE /api/projects/:id/files/:fid — remove a file spec
  const fileMatch = url.pathname.match(/^\/api\/projects\/(\d+)\/files\/(\d+)$/);
  if (fileMatch && req.method === "DELETE") {
    const projectId = Number(fileMatch[1]);
    const fileId = Number(fileMatch[2]);
    const row = db
      .query("SELECT id FROM project_files WHERE id = ? AND project_id = ?")
      .get(fileId, projectId) as { id: number } | null;
    if (!row) return new Response("File not found", { status: 404 });
    db.query("DELETE FROM project_files WHERE id = ?").run(row.id);
    return Response.json({ ok: true });
  }

  return null;
}

/** Raw file specs for a project (inline content + env_ref + octal mode text). */
export function getProjectFiles(projectId: number): FileSpec[] {
  return db
    .query("SELECT id, path, content, env_ref, mode FROM project_files WHERE project_id = ?")
    .all(projectId) as FileSpec[];
}

/** Files resolved against the project's env vars and ready to inject into a
 *  container (content + numeric mode). Used by createAndStartContainer callers.
 *  Throws if a file's env_ref names a var that isn't set on the project. */
export function getResolvedProjectFiles(
  projectId: number,
  envVars: { key: string; value: string }[],
): ResolvedFile[] {
  return resolveFiles(getProjectFiles(projectId), envVars);
}
