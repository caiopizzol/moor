import db from "../db";
import {
  buildProject,
  deployProject,
  type Project,
  type ProjectActionResult,
  restartProject,
  startProject,
  stopProject,
} from "../deploy";
import {
  EXEC_TIMEOUT_MAX_MS,
  EXEC_TIMEOUT_MIN_MS,
  ExecTimeoutError,
  execInContainer,
  getContainerLogs,
} from "../docker";
import { requireNotDraining } from "../drain";
import { validateGithubUrl } from "../github-url";
import { errorResponse } from "../http";
import {
  liveRequireErrorResponse,
  requireLiveContainer,
  setProjectLiveState,
} from "../status-reconciler";

export { buildErrorEvents, buildErrorResponse } from "../deploy";

export async function handleDocker(req: Request, url: URL): Promise<Response | null> {
  const match = url.pathname.match(
    /^\/api\/projects\/(\d+)\/(build|start|stop|restart|run|logs|exec)$/,
  );
  if (!match) return null;

  const id = Number(match[1]);
  const action = match[2];
  console.log(`[docker] ${req.method} /api/projects/${id}/${action}`);

  const project = db.query("SELECT * FROM projects WHERE id = ?").get(id) as Project | null;
  if (!project) {
    console.log(`[docker] project ${id} not found`);
    return errorResponse("Not found", 404);
  }
  console.log(
    `[docker] project: name=${project.name} status=${project.status} image=${project.image_tag} container=${project.container_id}`,
  );

  if (action === "build" && req.method === "POST") return handleBuild(project);
  if (action === "start" && req.method === "POST") return handleStart(project);
  if (action === "stop" && req.method === "POST") return handleStop(project);
  if (action === "restart" && req.method === "POST") return handleRestart(project);
  if (action === "run" && req.method === "POST") return handleRun(req, project);
  if (action === "logs" && req.method === "GET") return handleLogs(project, url);
  if (action === "exec" && req.method === "POST") return handleExec(req, project);

  return null;
}

function projectActionResultToResponse(result: ProjectActionResult): Response {
  switch (result.kind) {
    case "response":
      return result.response;
    case "json":
      return result.status === undefined
        ? Response.json(result.body)
        : Response.json(result.body, { status: result.status });
    case "stream":
      return new Response(result.stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
  }
}

async function handleRun(req: Request, project: Project): Promise<Response> {
  const url = new URL(req.url);
  const noCache = url.searchParams.get("nocache") === "true";
  const validationResponse = validateProjectGithubUrl(project);
  if (validationResponse) return validationResponse;
  return projectActionResultToResponse(await deployProject(project, { noCache }));
}

function validateProjectGithubUrl(project: Project): Response | null {
  if (!project.github_url) return null;
  const urlError = validateGithubUrl(project.github_url);
  if (!urlError) return null;
  return errorResponse(urlError, 400);
}

/** #74 pure helper: shape the response body + status from a
 *  LogsFetchResult and the cached live_status. Extracted so tests can
 *  drive each branch deterministically without depending on a real
 *  Docker daemon. */
export function buildLogsResponse(
  fetchResult: import("../docker").LogsFetchResult,
  liveStatus: string | null,
): { body: Record<string, unknown>; status: number } {
  if (!fetchResult.ok) {
    if (fetchResult.kind === "missing") {
      return { body: { logs: "", lastTimestamp: 0, state: "missing" }, status: 200 };
    }
    // docker_error → 502 Bad Gateway so callers can distinguish
    // infrastructure failure from app silence.
    return {
      body: { logs: "", lastTimestamp: 0, state: "docker_error", error: fetchResult.message },
      status: 502,
    };
  }
  // Logs fetched successfully. Use cached live_status (from the #71
  // reconciler) to label exited vs ok. We deliberately don't do a fresh
  // inspect here — for log fetching, a 30s cache is appropriate (this
  // isn't an action path). live_status null means the reconciler hasn't
  // ticked yet on this row; default to "ok" in that case.
  const state = liveStatus && liveStatus !== "running" ? "exited" : "ok";
  return {
    body: { logs: fetchResult.logs, lastTimestamp: fetchResult.lastTimestamp, state },
    status: 200,
  };
}

async function handleLogs(project: Project, url: URL): Promise<Response> {
  if (!project.container_id) {
    return Response.json({ logs: "", lastTimestamp: 0, state: "no_container" });
  }

  const sinceParam = url.searchParams.get("since");
  const tailParam = url.searchParams.get("tail");
  const opts: { since?: number; tail?: number } = {};
  if (sinceParam) opts.since = Number(sinceParam);
  if (tailParam) opts.tail = Number(tailParam);

  const result = await getContainerLogs(project.container_id, opts);

  // #74: opportunistically update live_status when we just learned the
  // container is gone. Matches the #73 requireLiveContainer pattern of
  // syncing the cache when we got the truth for free. Without this,
  // moor_status could keep showing stale live_status='running' even
  // though moor_logs just observed a 404.
  if (!result.ok && result.kind === "missing") {
    setProjectLiveState(project.id, project.container_id, "missing", null);
  }

  const live = db.query("SELECT live_status FROM projects WHERE id = ?").get(project.id) as {
    live_status: string | null;
  } | null;
  const { body, status } = buildLogsResponse(result, live?.live_status ?? null);
  return Response.json(body, { status });
}

async function handleExec(req: Request, project: Project): Promise<Response> {
  // #79: drain-mode gate. Sync exec is "new work against the container"
  // — same category as builds and async exec, so same gate. Lands
  // BEFORE the body parse and live-container check.
  const drained = requireNotDraining();
  if (drained) return drained;

  console.log(
    `[exec] project=${project.name} container=${project.container_id} status=${project.status}`,
  );

  // Validate cheap inputs first (no I/O). Live container check happens
  // AFTER so an operator sending bad timeout_ms gets a useful 400
  // rather than a 503 "Docker unreachable" they can't act on.
  const body = (await req.json()) as { command?: string; timeout_ms?: number };
  if (!body.command) {
    return errorResponse("Missing command", 400);
  }

  let timeout_ms: number | undefined;
  if (body.timeout_ms !== undefined) {
    if (
      !Number.isInteger(body.timeout_ms) ||
      body.timeout_ms < EXEC_TIMEOUT_MIN_MS ||
      body.timeout_ms > EXEC_TIMEOUT_MAX_MS
    ) {
      return errorResponse(
        `timeout_ms must be an integer between ${EXEC_TIMEOUT_MIN_MS} and ${EXEC_TIMEOUT_MAX_MS}`,
        400,
      );
    }
    timeout_ms = body.timeout_ms;
  }

  // #73: fresh Docker inspect, not cached project.status — the
  // recorded status field can lie about runtime truth (see #71).
  const live = await requireLiveContainer(project);
  const errorRes = liveRequireErrorResponse(live);
  if (errorRes) {
    console.log(`[exec] rejected — ${live.ok ? "" : live.reason}`);
    return errorRes;
  }

  console.log(`[exec] command: ${body.command}${timeout_ms ? ` timeout_ms=${timeout_ms}` : ""}`);
  try {
    const result = await execInContainer(project.container_id as string, body.command, {
      timeout_ms,
    });
    console.log(
      `[exec] exitCode=${result.exitCode} stdout=${result.stdout.length}chars stderr=${result.stderr.length}chars`,
    );
    return Response.json(result);
  } catch (e) {
    if (e instanceof ExecTimeoutError) {
      console.error(`[exec] TIMEOUT: ${e.message}`);
      return Response.json(
        {
          error: "timeout",
          timeout_ms: e.timeout_ms,
          // `killed` is the strict success signal: a target was located AND no
          // descendants survived in a live state. Zombies are excluded from
          // `live_remaining` since the container's PID 1 may not reap them.
          killed: e.killSentTo !== null && e.liveAfterKill === 0,
          killed_pid: e.killSentTo,
          live_remaining: e.liveAfterKill,
          message: e.message,
        },
        { status: 504 },
      );
    }
    const message = e instanceof Error ? e.message : "Unknown error";
    console.error(`[exec] FAILED: ${message}`);
    return errorResponse(message, 500);
  }
}

async function handleBuild(project: Project): Promise<Response> {
  const validationResponse = validateProjectGithubUrl(project);
  if (validationResponse) return validationResponse;
  return projectActionResultToResponse(await buildProject(project));
}

async function handleStart(project: Project): Promise<Response> {
  return projectActionResultToResponse(await startProject(project));
}

async function handleStop(project: Project): Promise<Response> {
  return projectActionResultToResponse(await stopProject(project));
}

async function handleRestart(project: Project): Promise<Response> {
  return projectActionResultToResponse(await restartProject(project));
}
