import {
  CRON_TIMEOUT_DEFAULT_MS,
  isJsonObject,
  validateCronSchedule,
  validateCronTimeoutMs,
} from "../../../packages/contract/src/index";
import { runCron } from "../cron";
import db from "../db";
import { requireNotDraining } from "../drain";
import { errorResponse } from "../http";
import { liveRequireErrorResponse, requireLiveContainer } from "../status-reconciler";

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
    // #79: drain-mode gate. Manual cron triggers are explicitly in
    // the drain refusal scope; scheduled-tick drain handling is in
    // cron.ts (writes a "skipped due to drain" run row instead).
    const drained = requireNotDraining();
    if (drained) return drained;

    const id = Number(runMatch[1]);
    const cron = db.query("SELECT * FROM crons WHERE id = ?").get(id) as {
      id: number;
      project_id: number;
      name: string;
      schedule: string;
      command: string;
      timeout_ms: number;
      enabled: number;
    } | null;
    if (!cron) return errorResponse("Cron not found", 404);

    const project = db
      .query("SELECT id, container_id, status FROM projects WHERE id = ?")
      .get(cron.project_id) as { id: number; container_id: string | null; status: string } | null;
    if (!project) return errorResponse("Project not found", 404);

    // #73: fresh inspect, not cached project.status — a manual cron
    // trigger is about to exec into the container.
    const live = await requireLiveContainer(project);
    const errorRes = liveRequireErrorResponse(live);
    if (errorRes) return errorRes;

    runCron(cron, project.container_id as string);
    return Response.json({ ok: true });
  }

  return null;
}

async function handleCreate(req: Request, projectId: number): Promise<Response> {
  const body: unknown = await req.json();
  if (!isJsonObject(body)) return errorResponse("Request body must be an object", 400);

  const { name, schedule, command } = body;
  if (
    typeof name !== "string" ||
    typeof schedule !== "string" ||
    typeof command !== "string" ||
    !name.trim() ||
    !schedule.trim() ||
    !command.trim()
  ) {
    return errorResponse("name, schedule, and command are required", 400);
  }
  const scheduleError = validateCronSchedule(schedule);
  if (scheduleError) return errorResponse(`Invalid schedule: ${scheduleError}`, 400);

  const requestedTimeout = body.timeout_ms ?? CRON_TIMEOUT_DEFAULT_MS;
  const timeoutError = validateCronTimeoutMs(requestedTimeout);
  if (timeoutError) return errorResponse(timeoutError, 400);
  const timeoutMs = requestedTimeout as number;

  const row = db
    .query(
      "INSERT INTO crons (project_id, name, schedule, command, timeout_ms) VALUES (?, ?, ?, ?, ?) RETURNING *",
    )
    .get(projectId, name, schedule, command, timeoutMs);

  return Response.json(row, { status: 201 });
}

async function handleUpdate(req: Request, id: number): Promise<Response> {
  const body: unknown = await req.json();
  if (!isJsonObject(body)) return errorResponse("Request body must be an object", 400);

  if ("schedule" in body) {
    if (typeof body.schedule !== "string") return errorResponse("schedule must be a string", 400);
    const scheduleError = validateCronSchedule(body.schedule);
    if (scheduleError) return errorResponse(`Invalid schedule: ${scheduleError}`, 400);
  }
  if ("timeout_ms" in body) {
    const timeoutError = validateCronTimeoutMs(body.timeout_ms);
    if (timeoutError) return errorResponse(timeoutError, 400);
  }

  const fields: string[] = [];
  const values: (string | number)[] = [];

  for (const key of ["name", "schedule", "command", "timeout_ms", "enabled"]) {
    if (key in body) {
      fields.push(`${key} = ?`);
      const value = body[key];
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
        return errorResponse(`${key} has an invalid value`, 400);
      }
      values.push(typeof value === "boolean" ? Number(value) : value);
    }
  }

  if (fields.length === 0) return errorResponse("No fields to update", 400);

  values.push(id);
  const row = db
    .query(`UPDATE crons SET ${fields.join(", ")} WHERE id = ? RETURNING *`)
    .get(...values);
  if (!row) return errorResponse("Not found", 404);

  return Response.json(row);
}
