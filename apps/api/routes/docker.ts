import { BuildRun } from "../build-runs";
import { syncCaddyRoutes } from "../caddy";
import db from "../db";
import {
  buildImageStreaming,
  createAndStartContainer,
  EXEC_TIMEOUT_MAX_MS,
  EXEC_TIMEOUT_MIN_MS,
  ExecTimeoutError,
  execInContainer,
  getContainerLogs,
  pullImageStreaming,
  stopContainer,
} from "../docker";
import { requireNotDraining } from "../drain";
import { autoDetectPorts, getProjectPorts } from "../ports";
import { redactCredentials, redactCredentialsInText } from "../redact";
import { type ResolveFailure, resolveCredentialForBuild } from "../source-credential-resolver";
import {
  liveRequireErrorResponse,
  reconcileProjectStatusAfterInterrupt,
  requireLiveContainer,
} from "../status-reconciler";
import { getProjectVolumes } from "./volumes";

type Project = {
  id: number;
  name: string;
  github_url: string | null;
  docker_image: string | null;
  branch: string;
  dockerfile: string;
  image_tag: string | null;
  container_id: string | null;
  status: string;
  domain: string | null;
  domain_port: number | null;
  restart_policy: string;
  memory_limit_mb: number | null;
  cpus: number | null;
  source_credential_id: number | null;
};

/** Map a build-time credential-resolver failure to an HTTP Response.
 *  Status mapping: 409 for ambiguity (caller has to pick), 400 for
 *  everything else (missing/mismatch/not-active/invalid url/conflict). */
function resolverFailureResponse(failure: ResolveFailure): Response {
  const status = failure.code === "source_credential_ambiguous" ? 409 : 400;
  return Response.json(failure, { status });
}

function validateGithubUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.endsWith("github.com")) return "Only GitHub URLs are supported";
  } catch {
    return "Invalid GitHub URL";
  }
  return null;
}

// #77: reconcileStatusAfterCancel moved to status-reconciler.ts as
// reconcileProjectStatusAfterInterrupt so the shutdown coordinator can
// reuse the same logic. Route callsites below import it from there.

export async function handleDocker(req: Request, url: URL): Promise<Response | null> {
  const match = url.pathname.match(/^\/api\/projects\/(\d+)\/(build|start|stop|run|logs|exec)$/);
  if (!match) return null;

  const id = Number(match[1]);
  const action = match[2];
  console.log(`[docker] ${req.method} /api/projects/${id}/${action}`);

  const project = db.query("SELECT * FROM projects WHERE id = ?").get(id) as Project | null;
  if (!project) {
    console.log(`[docker] project ${id} not found`);
    return new Response("Not found", { status: 404 });
  }
  console.log(
    `[docker] project: name=${project.name} status=${project.status} image=${project.image_tag} container=${project.container_id}`,
  );

  if (action === "build" && req.method === "POST") return handleBuild(project);
  if (action === "start" && req.method === "POST") return handleStart(project);
  if (action === "stop" && req.method === "POST") return handleStop(project);
  if (action === "run" && req.method === "POST") return handleRun(req, project);
  if (action === "logs" && req.method === "GET") return handleLogs(project, url);
  if (action === "exec" && req.method === "POST") return handleExec(req, project);

  return null;
}

async function handleRun(req: Request, project: Project): Promise<Response> {
  // #79: drain-mode gate. Cheapest check first — refuse new deploys
  // before parsing URL or touching Docker. handleStart fallback below
  // also goes through its own gate.
  const drained = requireNotDraining();
  if (drained) return drained;

  const url = new URL(req.url);
  const noCache = url.searchParams.get("nocache") === "true";
  const isImageProject = !!project.docker_image;
  console.log(
    `[run] starting run for project ${project.name} (id=${project.id}) type=${isImageProject ? "image" : "github"} nocache=${noCache}`,
  );

  if (!project.github_url && !project.docker_image) {
    if (project.image_tag) {
      console.log("[run] no source, starting existing image");
      return handleStart(project);
    }
    console.log("[run] no source or image_tag — nothing to do");
    return new Response("No GitHub URL or Docker image configured", { status: 400 });
  }

  if (project.github_url) {
    const urlError = validateGithubUrl(project.github_url);
    if (urlError) return new Response(urlError, { status: 400 });
  }

  // Resolve source credential BEFORE any side effects (status flip,
  // BuildRun row, SSE stream open). A resolver failure should look like
  // a validation error to the caller, not a half-built build run.
  // Image projects skip resolution; only github_url builds consume creds.
  let resolvedCloneUrl: string | null = null;
  let resolvedCredentialId: number | null = null;
  if (!isImageProject && project.github_url) {
    const resolved = resolveCredentialForBuild(
      project.github_url,
      project.source_credential_id ?? undefined,
    );
    if (!resolved.ok) {
      return resolverFailureResponse(resolved);
    }
    resolvedCloneUrl = resolved.value.cloneUrl;
    resolvedCredentialId = resolved.value.used_credential_id;
  }

  const tag = isImageProject ? project.docker_image! : `moor/${project.name}:latest`;
  const status = isImageProject ? "pulling" : "building";
  console.log(
    `[run] image tag will be: ${tag}` +
      (resolvedCredentialId !== null
        ? ` source_credential_id=${resolvedCredentialId}`
        : !isImageProject
          ? " anonymous-clone"
          : ""),
  );
  db.query(`UPDATE projects SET status = ? WHERE id = ?`).run(status, project.id);

  // #65: one deploy run row covers build/pull + port detection + container
  // start. INSERT before the build starts so moor_run_get can tail mid-build;
  // BuildRun periodically flushes the rolling tail into runs.stdout.
  const run = new BuildRun(project.id);

  // Stream build/pull output via SSE
  let streamClosed = false;
  let keepalive: ReturnType<typeof setInterval>;
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      const send = (event: string, data: string) => {
        if (streamClosed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          streamClosed = true;
        }
      };

      // Mirror every log line into both the SSE stream (for the UI/CLI) and
      // the persistent BuildRun (for moor_run_get). Single source of text.
      const log = (line: string) => {
        send("log", line);
        run.appendStdout(line);
      };

      const safeClose = () => {
        clearInterval(keepalive);
        if (streamClosed) return;
        streamClosed = true;
        try {
          controller.close();
        } catch {
          // Already closed
        }
      };

      keepalive = setInterval(() => {
        if (streamClosed) return;
        try {
          controller.enqueue(encoder.encode(":keepalive\n\n"));
        } catch {
          streamClosed = true;
        }
      }, 5000);

      const startTime = Date.now();

      try {
        if (isImageProject) {
          log(`Pulling ${project.docker_image}...\n`);
          await pullImageStreaming(project.docker_image!, log, run.abort.signal);
        } else {
          // resolvedCloneUrl is guaranteed non-null in this branch
          // (resolved above, before side effects).
          await buildImageStreaming(
            resolvedCloneUrl as string,
            project.branch,
            project.dockerfile,
            tag,
            log,
            noCache,
            run.abort.signal,
          );
        }

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const verb = isImageProject ? "Pull" : "Build";

        // #68: past this point cancel() can't stop anything useful — the
        // container-start phase below uses different Docker endpoints and
        // AbortController on the build/pull fetch won't reach them.
        run.markStreamingDone();

        db.query("UPDATE projects SET image_tag = ?, status = 'stopped' WHERE id = ?").run(
          tag,
          project.id,
        );

        log(`\n${verb} completed in ${elapsed}s\n`);

        // Auto-detect exposed ports from image
        const detectedPorts = await autoDetectPorts(project.id, tag, true);
        for (const { host_port, container_port } of detectedPorts) {
          log(`Port ${container_port} → host :${host_port}\n`);
        }
      } catch (e) {
        // #68: if cancel() fired AbortError, BuildRun.cancel already
        // finalized the row with exit_code=130 and "[cancelled by user]".
        // Don't re-finalize or overwrite with a generic failure. Also
        // reconcile status from the actual container state — the cancel
        // didn't touch the previously-running container, so leaving
        // status='error' would lie about the project state.
        if (run.abort.signal.aborted) {
          await reconcileProjectStatusAfterInterrupt(project.id, project.container_id);
          send("error", "cancelled by user");
          safeClose();
          return;
        }
        const rawMessage = e instanceof Error ? e.message : "Unknown error";
        // Redact any credentialed URLs Docker may have echoed into the
        // error message before it lands in logs, stored stderr, or SSE.
        const message = redactCredentialsInText(rawMessage);
        console.error(`[run] FAILED: ${message}`);
        run.appendStderr(`${message}\n`);
        run.finalize(1);
        db.query("UPDATE projects SET status = 'error' WHERE id = ?").run(project.id);
        send("error", message);
        safeClose();
        return;
      }

      // Container start is part of the same deploy run — operator's
      // mental model is "rebuild" includes "and is now running."
      try {
        const envs = db
          .query("SELECT key, value FROM env_vars WHERE project_id = ?")
          .all(project.id) as { key: string; value: string }[];
        const ports = getProjectPorts(project.id);

        log("Starting container...\n");
        const containerId = await createAndStartContainer(
          tag,
          `moor-${project.name}`,
          envs,
          ports,
          project.restart_policy,
          { memoryLimitMb: project.memory_limit_mb, cpus: project.cpus },
          getProjectVolumes(project.id),
        );
        console.log(`[run] container started: ${containerId}`);

        db.query("UPDATE projects SET container_id = ?, status = 'running' WHERE id = ?").run(
          containerId,
          project.id,
        );

        if (project.domain) {
          await syncCaddyRoutes();
          log(`Route: ${project.domain} -> :${project.domain_port}\n`);
        }

        run.finalize(0);
        send("done", "Container started");
      } catch (e) {
        db.query("UPDATE projects SET status = 'error' WHERE id = ?").run(project.id);
        const message = e instanceof Error ? e.message : "Unknown error";
        console.error(`[run] CONTAINER START FAILED: ${message}`);
        run.appendStderr(`${message}\n`);
        run.finalize(1);
        send("error", message);
      }

      safeClose();
    },
    cancel() {
      clearInterval(keepalive);
      streamClosed = true;
      // If the client disconnects mid-build the build still runs to
      // completion on the daemon and finalize() will fire from the build
      // try/catch above. No need to finalize here.
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
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
    db.query(
      `UPDATE projects SET live_status = 'missing', live_exit_code = NULL,
                           live_checked_at = datetime('now'), live_error = NULL
       WHERE id = ?`,
    ).run(project.id);
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
    return new Response("Missing command", { status: 400 });
  }

  let timeout_ms: number | undefined;
  if (body.timeout_ms !== undefined) {
    if (
      !Number.isInteger(body.timeout_ms) ||
      body.timeout_ms < EXEC_TIMEOUT_MIN_MS ||
      body.timeout_ms > EXEC_TIMEOUT_MAX_MS
    ) {
      return new Response(
        `timeout_ms must be an integer between ${EXEC_TIMEOUT_MIN_MS} and ${EXEC_TIMEOUT_MAX_MS}`,
        { status: 400 },
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
    return new Response(message, { status: 500 });
  }
}

async function handleBuild(project: Project): Promise<Response> {
  // #79: drain-mode gate. Builds are explicitly listed in the drain
  // refusal scope — they're long-running work that an upgrade can't
  // safely interleave with.
  const drained = requireNotDraining();
  if (drained) return drained;

  console.log(
    `[build] project=${project.name} github_url=${redactCredentials(project.github_url) ?? ""}`,
  );
  if (!project.github_url) {
    console.log("[build] rejected — no github_url");
    return new Response("No GitHub URL configured", { status: 400 });
  }
  const urlError = validateGithubUrl(project.github_url);
  if (urlError) return new Response(urlError, { status: 400 });

  // Resolve source credential BEFORE any side effects (status flip,
  // BuildRun row). Same contract as /run.
  const resolved = resolveCredentialForBuild(
    project.github_url,
    project.source_credential_id ?? undefined,
  );
  if (!resolved.ok) {
    return resolverFailureResponse(resolved);
  }
  const { cloneUrl, used_credential_id } = resolved.value;

  const tag = `moor/${project.name}:latest`;
  console.log(
    `[build] tag=${tag} branch=${project.branch} dockerfile=${project.dockerfile} ` +
      (used_credential_id !== null
        ? `source_credential_id=${used_credential_id}`
        : "anonymous-clone"),
  );
  db.query("UPDATE projects SET status = 'building' WHERE id = ?").run(project.id);

  // /build is the legacy non-SSE path used by api.projects.build in the web
  // wrapper. We still wire it through BuildRun + buildImageStreaming so the
  // row shape (started_at_ms, totals, exit_code, orphan-sweep eligibility)
  // matches /run and moor_run_get can tail it mid-build. Returns when the
  // build finishes, like the old contract.
  const run = new BuildRun(project.id);

  try {
    console.log("[build] starting docker build...");
    await buildImageStreaming(
      cloneUrl,
      project.branch,
      project.dockerfile,
      tag,
      (line) => run.appendStdout(line),
      false,
      run.abort.signal,
    );
    run.markStreamingDone();
    db.query("UPDATE projects SET image_tag = ?, status = 'stopped' WHERE id = ?").run(
      tag,
      project.id,
    );

    // Auto-detect exposed ports from image (always re-detect on rebuild)
    await autoDetectPorts(project.id, tag, true);

    run.finalize(0);
    console.log("[build] done — status set to 'stopped'");
    return Response.json({ message: "Build complete" });
  } catch (e) {
    // #68: cancel already finalized as exit 130 with "[cancelled by user]";
    // don't overwrite with a generic failure. Reconcile status from the
    // actual container state — the cancel didn't touch a running container.
    if (run.abort.signal.aborted) {
      await reconcileProjectStatusAfterInterrupt(project.id, project.container_id);
      return new Response("cancelled by user", { status: 499 });
    }
    db.query("UPDATE projects SET status = 'error' WHERE id = ?").run(project.id);
    const rawMessage = e instanceof Error ? e.message : "Unknown error";
    const message = redactCredentialsInText(rawMessage);
    console.error(`[build] FAILED: ${message}`);
    run.appendStderr(`${message}\n`);
    run.finalize(1);
    return new Response(message, { status: 500 });
  }
}

async function handleStart(project: Project): Promise<Response> {
  // #79: drain-mode gate. Starting a container is "new work" from
  // moor's perspective — same gate as deploy/build. Stop/logs stay
  // open so operators can quiesce things during drain.
  const drained = requireNotDraining();
  if (drained) return drained;

  console.log(`[start] project=${project.name} image=${project.image_tag}`);
  if (!project.image_tag) {
    console.log("[start] rejected — no image built");
    return new Response("No image built yet", { status: 400 });
  }

  const envs = db.query("SELECT key, value FROM env_vars WHERE project_id = ?").all(project.id) as {
    key: string;
    value: string;
  }[];
  const ports = getProjectPorts(project.id);
  console.log(
    `[start] creating container moor-${project.name} with ${envs.length} env vars and ${ports.length} ports`,
  );

  try {
    const containerId = await createAndStartContainer(
      project.image_tag,
      `moor-${project.name}`,
      envs,
      ports,
      project.restart_policy,
      { memoryLimitMb: project.memory_limit_mb, cpus: project.cpus },
      getProjectVolumes(project.id),
    );
    console.log(`[start] container started: ${containerId}`);
    db.query("UPDATE projects SET container_id = ?, status = 'running' WHERE id = ?").run(
      containerId,
      project.id,
    );

    if (project.domain) {
      await syncCaddyRoutes();
    }

    return Response.json({ message: "Container started" });
  } catch (e) {
    db.query("UPDATE projects SET status = 'error' WHERE id = ?").run(project.id);
    const message = e instanceof Error ? e.message : "Unknown error";
    console.error(`[start] FAILED: ${message}`);
    return new Response(message, { status: 500 });
  }
}

async function handleStop(project: Project): Promise<Response> {
  console.log(`[stop] project=${project.name} container=${project.container_id}`);
  if (!project.container_id) {
    console.log("[stop] no container — marking as stopped");
    db.query("UPDATE projects SET status = 'stopped' WHERE id = ?").run(project.id);
    return Response.json({ message: "Container stopped" });
  }

  try {
    await stopContainer(project.container_id);
    console.log("[stop] container stopped");
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    console.error(`[stop] error during stop (marking as stopped anyway): ${message}`);
  }

  db.query("UPDATE projects SET status = 'stopped' WHERE id = ?").run(project.id);
  return Response.json({ message: "Container stopped" });
}
