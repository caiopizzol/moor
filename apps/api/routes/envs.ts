import type {
  MergeEnvVarsRequest,
  MergeEnvVarsResponse,
} from "../../../packages/contract/src/index";
import db from "../db";
import {
  type Project,
  type ProjectActionResult,
  type RestartProjectInput,
  restartProject,
  withProjectLifecycleLocks,
} from "../deploy";
import { errorResponse, readJsonObject, responseErrorMessage } from "../http";

type EnvRouteDeps = {
  restartProject: (project: Project, input: RestartProjectInput) => Promise<ProjectActionResult>;
};

export async function handleEnvs(
  req: Request,
  url: URL,
  partialDeps?: Partial<EnvRouteDeps>,
): Promise<Response | null> {
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

  if (req.method === "POST") {
    const json = await readJsonObject(req);
    if (!json.ok) return json.response;
    const input = parseMergeRequest(json.value);
    if (typeof input === "string") return errorResponse(input, 400);

    const project = getProject(projectId);
    if (!project) return errorResponse("Not found", 404);

    return await withProjectLifecycleLocks(project, async () => {
      const currentProject = getProject(projectId);
      if (!currentProject) return errorResponse("Not found", 404);

      const updatedKeys = mergeProjectEnvs(projectId, input.vars);
      if (currentProject.status !== "running") {
        return Response.json({
          updated_keys: updatedKeys,
          restarted: false,
        } satisfies MergeEnvVarsResponse);
      }

      const restart =
        partialDeps?.restartProject ??
        ((target, options) => restartProject(target, undefined, options));
      const result = await restart(currentProject, { lifecycleLockHeld: true });
      const failure = await restartFailure(result, updatedKeys);
      if (failure) return failure;
      return Response.json({
        updated_keys: updatedKeys,
        restarted: true,
      } satisfies MergeEnvVarsResponse);
    });
  }

  return null;
}

function getProject(projectId: number): Project | null {
  return db.query("SELECT * FROM projects WHERE id = ?").get(projectId) as Project | null;
}

function parseMergeRequest(value: unknown): MergeEnvVarsRequest | string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "body must be an object";
  }
  const vars = (value as { vars?: unknown }).vars;
  if (typeof vars !== "object" || vars === null || Array.isArray(vars)) {
    return "vars must be an object of string values";
  }
  const entries = Object.entries(vars);
  if (entries.length === 0) return "vars must contain at least one environment variable";
  if (entries.some(([key, entry]) => key.trim() === "" || typeof entry !== "string")) {
    return "vars must contain non-empty keys and string values";
  }
  return { vars: vars as Record<string, string> };
}

export function mergeProjectEnvs(projectId: number, vars: Record<string, string>): string[] {
  const normalized = new Map(Object.entries(vars).map(([key, value]) => [key.trim(), value]));
  const upsert = db.query(
    "INSERT INTO env_vars (project_id, key, value) VALUES (?, ?, ?) " +
      "ON CONFLICT(project_id, key) DO UPDATE SET value = excluded.value",
  );
  db.transaction(() => {
    for (const [key, value] of normalized) upsert.run(projectId, key, value);
  })();
  return [...normalized.keys()].sort();
}

async function restartFailure(
  result: ProjectActionResult,
  updatedKeys: string[],
): Promise<Response | null> {
  if (result.kind === "json" && (result.status === undefined || result.status < 400)) return null;

  let status = 500;
  let message = "Unexpected restart response";
  if (result.kind === "response") {
    status = result.response.status;
    message = await responseErrorMessage(result.response);
  } else if (result.kind === "json") {
    status = result.status ?? 500;
    message =
      typeof result.body === "object" &&
      result.body !== null &&
      "error" in result.body &&
      typeof result.body.error === "string"
        ? result.body.error
        : JSON.stringify(result.body);
  }
  return Response.json(
    {
      error: `Environment variables were updated, but restart failed: ${message}`,
      env_updated: true,
      updated_keys: updatedKeys,
    },
    { status },
  );
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
