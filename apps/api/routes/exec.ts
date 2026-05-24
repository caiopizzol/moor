import db from "../db";
import {
  EXEC_ASYNC_TIMEOUT_DEFAULT_MS,
  EXEC_ASYNC_TIMEOUT_MAX_MS,
  EXEC_ASYNC_TIMEOUT_MIN_MS,
  getRunStatus,
  startAsyncExec,
  stopAsyncExec,
} from "../exec-async";
import { liveRequireErrorResponse, requireLiveContainer } from "../status-reconciler";

type Project = { id: number; container_id: string | null; status: string };

export async function handleExec(req: Request, url: URL): Promise<Response | null> {
  // POST /api/projects/:id/exec/async
  const startMatch = url.pathname.match(/^\/api\/projects\/(\d+)\/exec\/async$/);
  if (startMatch && req.method === "POST") {
    const projectId = Number(startMatch[1]);
    const project = db
      .query("SELECT id, container_id, status FROM projects WHERE id = ?")
      .get(projectId) as Project | null;
    if (!project) return new Response("Project not found", { status: 404 });

    // Validate cheap inputs first (no I/O); fresh live check after so
    // an operator with bad timeout_ms gets a useful 400, not a 503.
    const body = (await req.json()) as { command?: string; timeout_ms?: number };
    if (!body.command) return new Response("Missing command", { status: 400 });

    let timeoutMs = EXEC_ASYNC_TIMEOUT_DEFAULT_MS;
    if (body.timeout_ms !== undefined) {
      if (
        !Number.isInteger(body.timeout_ms) ||
        body.timeout_ms < EXEC_ASYNC_TIMEOUT_MIN_MS ||
        body.timeout_ms > EXEC_ASYNC_TIMEOUT_MAX_MS
      ) {
        return new Response(
          `timeout_ms must be an integer between ${EXEC_ASYNC_TIMEOUT_MIN_MS} and ${EXEC_ASYNC_TIMEOUT_MAX_MS}`,
          { status: 400 },
        );
      }
      timeoutMs = body.timeout_ms;
    }

    // #73: fresh inspect, not cached project.status — exec is about
    // to talk to the container; stale cache can approve against a
    // dead one.
    const live = await requireLiveContainer(project);
    const errorRes = liveRequireErrorResponse(live);
    if (errorRes) return errorRes;

    console.log(
      `[exec-async] start project=${projectId} command="${body.command}" timeout_ms=${timeoutMs}`,
    );
    const { runId } = startAsyncExec({
      projectId,
      containerId: project.container_id as string,
      command: body.command,
      timeoutMs,
    });
    return Response.json({ run_id: runId }, { status: 201 });
  }

  // GET /api/exec/:run_id
  const statusMatch = url.pathname.match(/^\/api\/exec\/(\d+)$/);
  if (statusMatch && req.method === "GET") {
    const runId = Number(statusMatch[1]);
    const status = getRunStatus(runId);
    if (!status) return new Response("Run not found", { status: 404 });
    return Response.json(status);
  }

  // POST /api/exec/:run_id/stop
  const stopMatch = url.pathname.match(/^\/api\/exec\/(\d+)\/stop$/);
  if (stopMatch && req.method === "POST") {
    const runId = Number(stopMatch[1]);
    const result = await stopAsyncExec(runId);
    if (result.state === "not_found") return Response.json(result, { status: 404 });
    if (result.state === "not_running") return Response.json(result, { status: 409 });
    return Response.json(result);
  }

  return null;
}
