import { classifyBuildError } from "./build-error-classifier";
import { BuildRun } from "./build-runs";
import { syncCaddyRoutes } from "./caddy";
import { parseStringArray, type ResolvedFile } from "./container-config";
import db from "./db";
import {
  buildImageStreaming,
  createAndStartContainer,
  projectLabels,
  pullImageStreaming,
  stopContainer,
} from "./docker";
import { requireNotDraining } from "./drain";
import { validateGithubUrl } from "./github-url";
import { errorResponse, responseErrorMessage } from "./http";
import { autoDetectPorts, getProjectPorts } from "./ports";
import { redactCredentials, redactCredentialsInText } from "./redact";
import { getResolvedProjectFiles } from "./routes/files";
import { getProjectVolumes } from "./routes/volumes";
import { type ResolveFailure, resolveCredentialForBuild } from "./source-credential-resolver";
import {
  reconcileProjectStatusAfterInterrupt,
  setProjectRecordedStatus,
} from "./status-reconciler";

export type Project = {
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
  // JSON-encoded string arrays (or null). Parsed via parseStringArray before
  // they reach the Docker create body as Cmd / Entrypoint.
  command: string | null;
  entrypoint: string | null;
};

type EnvVar = { key: string; value: string };
type PortBinding = { host_port: number; container_port: number };
type VolumeMount = { docker_name: string; target: string };
type ProjectLifecycleState = Pick<Project, "image_tag" | "container_id">;

type ContainerStartConfig = {
  envs: EnvVar[];
  ports: PortBinding[];
  volumes: VolumeMount[];
  labels: Record<string, string>;
  extras: {
    command: string[] | null;
    entrypoint: string[] | null;
    files: ResolvedFile[];
  };
};

export type ProjectActionResult =
  | { kind: "response"; response: Response }
  | { kind: "json"; body: unknown; status?: number }
  | {
      kind: "stream";
      stream: ReadableStream<Uint8Array>;
      completion?: Promise<void>;
    };

export type DeployProjectInput = {
  noCache: boolean;
  lifecycleLockHeld?: boolean;
};

export type RestartProjectInput = {
  lifecycleLockHeld?: boolean;
};

export type BuildRunLike = {
  readonly abort: AbortController;
  appendStdout(text: string): void;
  appendStderr(text: string): void;
  markStreamingDone(): void;
  finalize(exitCode: number): void;
};

export type DeployDeps = {
  requireNotDraining: () => Response | null;
  resolveCredentialForBuild: typeof resolveCredentialForBuild;
  setProjectRecordedStatus: typeof setProjectRecordedStatus;
  reconcileProjectStatusAfterInterrupt: typeof reconcileProjectStatusAfterInterrupt;
  createBuildRun: (projectId: number) => BuildRunLike;
  buildImageStreaming: typeof buildImageStreaming;
  pullImageStreaming: typeof pullImageStreaming;
  autoDetectPorts: (projectId: number, imageTag: string, force?: boolean) => Promise<PortBinding[]>;
  listEnvVars: (projectId: number) => EnvVar[];
  getProjectPorts: (projectId: number) => PortBinding[];
  getProjectVolumes: (projectId: number) => VolumeMount[];
  getResolvedProjectFiles: (projectId: number, envs: EnvVar[]) => ResolvedFile[];
  createAndStartContainer: typeof createAndStartContainer;
  stopContainer: typeof stopContainer;
  getProjectLifecycleState: (project: Project) => ProjectLifecycleState | null;
  syncCaddyRoutes: typeof syncCaddyRoutes;
  updateProjectImageTag: (projectId: number, imageTag: string) => void;
  updateProjectContainerId: (projectId: number, containerId: string) => void;
  now: () => number;
};

function makeDefaultDeps(): DeployDeps {
  return {
    requireNotDraining,
    resolveCredentialForBuild,
    setProjectRecordedStatus,
    reconcileProjectStatusAfterInterrupt,
    createBuildRun: (projectId) => new BuildRun(projectId),
    buildImageStreaming,
    pullImageStreaming,
    autoDetectPorts,
    listEnvVars: (projectId) =>
      db.query("SELECT key, value FROM env_vars WHERE project_id = ?").all(projectId) as EnvVar[],
    getProjectPorts,
    getProjectVolumes,
    getResolvedProjectFiles,
    createAndStartContainer,
    stopContainer,
    getProjectLifecycleState: (project) =>
      db
        .query("SELECT image_tag, container_id FROM projects WHERE id = ?")
        .get(project.id) as ProjectLifecycleState | null,
    syncCaddyRoutes,
    updateProjectImageTag: (projectId, imageTag) => {
      db.query("UPDATE projects SET image_tag = ? WHERE id = ?").run(imageTag, projectId);
    },
    updateProjectContainerId: (projectId, containerId) => {
      db.query("UPDATE projects SET container_id = ? WHERE id = ?").run(containerId, projectId);
    },
    now: () => Date.now(),
  };
}

function makeDeployDeps(partialDeps?: Partial<DeployDeps>): DeployDeps {
  return { ...makeDefaultDeps(), ...partialDeps };
}

// Fixed-name replacement is destructive, so start, stop, restart, deploy,
// and project deletion queue through one critical section per project.
const projectLifecycleTails = new Map<string, Promise<void>>();

async function acquireLifecycleLock(key: string): Promise<() => void> {
  const previous = projectLifecycleTails.get(key) ?? Promise.resolve();
  let release: () => void = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  projectLifecycleTails.set(key, current);

  await previous;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
    if (projectLifecycleTails.get(key) === current) {
      projectLifecycleTails.delete(key);
    }
  };
}

export function acquireProjectLifecycleLock(projectId: number): Promise<() => void> {
  return acquireLifecycleLock(`id:${projectId}`);
}

export function acquireProjectNameLifecycleLock(projectName: string): Promise<() => void> {
  return acquireLifecycleLock(`name:${projectName}`);
}

export async function withProjectLifecycleLock<T>(
  projectId: number,
  run: () => Promise<T> | T,
): Promise<T> {
  const release = await acquireProjectLifecycleLock(projectId);
  try {
    return await run();
  } finally {
    release();
  }
}

export async function withProjectLifecycleLocks<T>(
  project: Pick<Project, "id" | "name">,
  run: () => Promise<T> | T,
): Promise<T> {
  const releaseName = await acquireProjectNameLifecycleLock(project.name);
  const releaseId = await acquireProjectLifecycleLock(project.id);
  try {
    return await run();
  } finally {
    releaseId();
    releaseName();
  }
}

function refreshProjectLifecycleState(project: Project, deps: DeployDeps): Project | null {
  const latest = deps.getProjectLifecycleState(project);
  return latest === null ? null : { ...project, ...latest };
}

function resolverFailureResult(failure: ResolveFailure): ProjectActionResult {
  return { kind: "json", body: failure, status: 400 };
}

function errorResult(message: string, status: number): ProjectActionResult {
  return { kind: "response", response: errorResponse(message, status) };
}

/** Build the /build catch-path response from an already-redacted error
 *  message. Classified auth failures (#119) become 401 JSON with a
 *  structured code so agents can branch; unclassified errors use the
 *  standard JSON error envelope. */
export function buildErrorResponse(message: string): Response {
  const code = classifyBuildError(message);
  if (code !== "unknown") {
    return Response.json({ code, message }, { status: 401 });
  }
  return errorResponse(message, 500);
}

/** SSE events to emit on a /run catch-path failure from an already-
 *  redacted error message. structured-error fires first when the failure
 *  classifies (#119) so a parsing agent can branch on the code; the
 *  trailing legacy event: error keeps existing UI/CLI/MCP consumers
 *  working unchanged. */
export function buildErrorEvents(
  message: string,
): Array<
  | { event: "structured-error"; data: { code: string; message: string } }
  | { event: "error"; data: string }
> {
  const code = classifyBuildError(message);
  const events: ReturnType<typeof buildErrorEvents> = [];
  if (code !== "unknown") {
    events.push({ event: "structured-error", data: { code, message } });
  }
  events.push({ event: "error", data: message });
  return events;
}

function buildErrorResult(message: string): ProjectActionResult {
  const code = classifyBuildError(message);
  if (code !== "unknown") {
    return { kind: "json", body: { code, message }, status: 401 };
  }
  return errorResult(message, 500);
}

function buildContainerStartConfig(
  project: Project,
  deps: DeployDeps,
  envs = deps.listEnvVars(project.id),
  ports = deps.getProjectPorts(project.id),
): ContainerStartConfig {
  return {
    envs,
    ports,
    volumes: deps.getProjectVolumes(project.id),
    labels: projectLabels(project.id, project.name),
    extras: {
      command: parseStringArray(project.command),
      entrypoint: parseStringArray(project.entrypoint),
      files: deps.getResolvedProjectFiles(project.id, envs),
    },
  };
}

async function createStartAndRecord(
  project: Project,
  imageTag: string,
  deps: DeployDeps,
  config = buildContainerStartConfig(project, deps),
): Promise<string> {
  const containerId = await deps.createAndStartContainer(
    imageTag,
    `moor-${project.name}`,
    config.envs,
    config.ports,
    project.restart_policy,
    { memoryLimitMb: project.memory_limit_mb, cpus: project.cpus },
    config.volumes,
    config.labels,
    config.extras,
  );
  deps.updateProjectContainerId(project.id, containerId);
  deps.setProjectRecordedStatus(project.id, "running", containerId);

  if (project.domain) {
    await deps.syncCaddyRoutes();
  }

  return containerId;
}

export async function deployProject(
  project: Project,
  input: DeployProjectInput,
  partialDeps?: Partial<DeployDeps>,
): Promise<ProjectActionResult> {
  const deps = makeDeployDeps(partialDeps);

  // #79: drain-mode gate. Cheapest check first - refuse new deploys
  // before parsing URL or touching Docker. startProject fallback below
  // also goes through its own gate.
  const drained = deps.requireNotDraining();
  if (drained) return { kind: "response", response: drained };

  const noCache = input.noCache;
  const dockerImage = project.docker_image;
  const isImageProject = !!dockerImage;
  console.log(
    `[run] starting run for project ${project.name} (id=${project.id}) type=${isImageProject ? "image" : "github"} nocache=${noCache}`,
  );

  if (!project.github_url && !project.docker_image) {
    if (project.image_tag) {
      console.log("[run] no source, starting existing image");
      return input.lifecycleLockHeld
        ? startProjectAfterDrainCheck(project, deps)
        : startProject(project, deps);
    }
    console.log("[run] no source or image_tag — nothing to do");
    return errorResult("No GitHub URL or Docker image configured", 400);
  }

  if (project.github_url) {
    const urlError = validateGithubUrl(project.github_url);
    if (urlError) return errorResult(urlError, 400);
  }

  // Resolve source credential BEFORE any side effects (status flip,
  // BuildRun row, SSE stream open). A resolver failure should look like
  // a validation error to the caller, not a half-built build run.
  // Image projects skip resolution; only github_url builds consume creds.
  let resolvedCloneUrl: string | null = null;
  let resolvedCredentialId: number | null = null;
  if (!isImageProject && project.github_url) {
    const resolved = deps.resolveCredentialForBuild(
      project.github_url,
      project.source_credential_id ?? undefined,
    );
    if (!resolved.ok) {
      return resolverFailureResult(resolved);
    }
    resolvedCloneUrl = resolved.value.cloneUrl;
    resolvedCredentialId = resolved.value.used_credential_id;
  }

  const tag = dockerImage || `moor/${project.name}:latest`;
  const status = isImageProject ? "pulling" : "building";
  console.log(
    `[run] image tag will be: ${tag}` +
      (resolvedCredentialId !== null
        ? ` source_credential_id=${resolvedCredentialId}`
        : !isImageProject
          ? " anonymous-clone"
          : ""),
  );

  // Stream build/pull output via SSE
  let streamClosed = false;
  let keepalive: ReturnType<typeof setInterval> | null = null;
  let markComplete: () => void = () => {};
  const completion = new Promise<void>((resolve) => {
    markComplete = resolve;
  });
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();

      // data is JSON-stringified, so strings come through as JSON strings
      // and objects (used by event: structured-error in #119) come through
      // as JSON objects. Consumers JSON.parse once to get the original.
      const send = (event: string, data: unknown) => {
        if (streamClosed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          streamClosed = true;
        }
      };

      const safeClose = () => {
        if (keepalive !== null) clearInterval(keepalive);
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

      const runLifecycle = async () => {
        const drained = deps.requireNotDraining();
        if (drained) {
          send("error", await responseErrorMessage(drained));
          return;
        }

        const currentProject = refreshProjectLifecycleState(project, deps);
        if (!currentProject) {
          send("error", "Not found");
          return;
        }

        deps.setProjectRecordedStatus(project.id, status, currentProject.container_id);

        // #65: one deploy run row covers build/pull + port detection + container
        // start. INSERT before the build starts so moor_run_get can tail mid-build;
        // BuildRun periodically flushes the rolling tail into runs.stdout.
        const run = deps.createBuildRun(project.id);

        // Mirror every log line into both the SSE stream (for the UI/CLI) and
        // the persistent BuildRun (for moor_run_get). Single source of text.
        const log = (line: string) => {
          send("log", line);
          run.appendStdout(line);
        };

        const startTime = deps.now();

        try {
          if (dockerImage) {
            log(`Pulling ${dockerImage}...\n`);
            await deps.pullImageStreaming(dockerImage, log, run.abort.signal);
          } else {
            // resolvedCloneUrl is guaranteed non-null in this branch
            // (resolved above, before side effects).
            await deps.buildImageStreaming(
              resolvedCloneUrl as string,
              project.branch,
              project.dockerfile,
              tag,
              log,
              noCache,
              run.abort.signal,
            );
          }

          const elapsed = ((deps.now() - startTime) / 1000).toFixed(1);
          const verb = isImageProject ? "Pull" : "Build";

          // #68: past this point cancel() can't stop anything useful - the
          // container-start phase below uses different Docker endpoints and
          // AbortController on the build/pull fetch won't reach them.
          run.markStreamingDone();

          deps.updateProjectImageTag(project.id, tag);
          deps.setProjectRecordedStatus(project.id, "stopped", currentProject.container_id);

          log(`\n${verb} completed in ${elapsed}s\n`);

          // Auto-detect exposed ports from image
          const detectedPorts = await deps.autoDetectPorts(project.id, tag, true);
          for (const { host_port, container_port } of detectedPorts) {
            log(`Port ${container_port} → host :${host_port}\n`);
          }
        } catch (e) {
          // #68: if cancel() fired AbortError, BuildRun.cancel already
          // finalized the row with exit_code=130 and "[cancelled by user]".
          // Don't re-finalize or overwrite with a generic failure. Also
          // reconcile status from the actual container state - the cancel
          // didn't touch the previously-running container, so leaving
          // status='error' would lie about the project state.
          if (run.abort.signal.aborted) {
            await deps.reconcileProjectStatusAfterInterrupt(
              project.id,
              currentProject.container_id,
            );
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
          deps.setProjectRecordedStatus(project.id, "error", currentProject.container_id);
          for (const ev of buildErrorEvents(message)) send(ev.event, ev.data);
          safeClose();
          return;
        }

        // Container start is part of the same deploy run - operator's
        // mental model is "rebuild" includes "and is now running."
        try {
          log("Starting container...\n");
          const containerId = await createStartAndRecord(currentProject, tag, deps);
          console.log(`[run] container started: ${containerId}`);

          if (currentProject.domain) {
            log(`Route: ${currentProject.domain} -> :${currentProject.domain_port}\n`);
          }

          run.finalize(0);
          send("done", "Container started");
        } catch (e) {
          deps.setProjectRecordedStatus(project.id, "error", currentProject.container_id);
          const message = e instanceof Error ? e.message : "Unknown error";
          console.error(`[run] CONTAINER START FAILED: ${message}`);
          run.appendStderr(`${message}\n`);
          run.finalize(1);
          send("error", message);
        }
      };

      try {
        if (input.lifecycleLockHeld) await runLifecycle();
        else await withProjectLifecycleLocks(project, runLifecycle);
        safeClose();
      } finally {
        if (keepalive !== null) clearInterval(keepalive);
        markComplete();
      }
    },
    cancel() {
      if (keepalive !== null) clearInterval(keepalive);
      streamClosed = true;
      // If the client disconnects mid-build the build still runs to
      // completion on the daemon and finalize() will fire from the build
      // try/catch above. No need to finalize here.
    },
  });

  return { kind: "stream", stream, completion };
}

export async function buildProject(
  project: Project,
  partialDeps?: Partial<DeployDeps>,
): Promise<ProjectActionResult> {
  const deps = makeDeployDeps(partialDeps);

  // #79: drain-mode gate. Builds are explicitly listed in the drain
  // refusal scope - they're long-running work that an upgrade can't
  // safely interleave with.
  const drained = deps.requireNotDraining();
  if (drained) return { kind: "response", response: drained };

  console.log(
    `[build] project=${project.name} github_url=${redactCredentials(project.github_url) ?? ""}`,
  );
  if (!project.github_url) {
    console.log("[build] rejected — no github_url");
    return errorResult("No GitHub URL configured", 400);
  }
  const urlError = validateGithubUrl(project.github_url);
  if (urlError) return errorResult(urlError, 400);

  // Resolve source credential BEFORE any side effects (status flip,
  // BuildRun row). Same contract as /run.
  const resolved = deps.resolveCredentialForBuild(
    project.github_url,
    project.source_credential_id ?? undefined,
  );
  if (!resolved.ok) {
    return resolverFailureResult(resolved);
  }
  const { cloneUrl, used_credential_id } = resolved.value;

  const tag = `moor/${project.name}:latest`;
  console.log(
    `[build] tag=${tag} branch=${project.branch} dockerfile=${project.dockerfile} ` +
      (used_credential_id !== null
        ? `source_credential_id=${used_credential_id}`
        : "anonymous-clone"),
  );
  deps.setProjectRecordedStatus(project.id, "building", project.container_id);

  // /build is the legacy non-SSE path used by api.projects.build in the web
  // wrapper. We still wire it through BuildRun + buildImageStreaming so the
  // row shape (started_at_ms, totals, exit_code, orphan-sweep eligibility)
  // matches /run and moor_run_get can tail it mid-build. Returns when the
  // build finishes, like the old contract.
  const run = deps.createBuildRun(project.id);

  try {
    console.log("[build] starting docker build...");
    await deps.buildImageStreaming(
      cloneUrl,
      project.branch,
      project.dockerfile,
      tag,
      (line) => run.appendStdout(line),
      false,
      run.abort.signal,
    );
    run.markStreamingDone();
    deps.updateProjectImageTag(project.id, tag);
    deps.setProjectRecordedStatus(project.id, "stopped", project.container_id);

    // Auto-detect exposed ports from image (always re-detect on rebuild)
    await deps.autoDetectPorts(project.id, tag, true);

    run.finalize(0);
    console.log("[build] done — status set to 'stopped'");
    return { kind: "json", body: { message: "Build complete" } };
  } catch (e) {
    // #68: cancel already finalized as exit 130 with "[cancelled by user]";
    // don't overwrite with a generic failure. Reconcile status from the
    // actual container state - the cancel didn't touch a running container.
    if (run.abort.signal.aborted) {
      await deps.reconcileProjectStatusAfterInterrupt(project.id, project.container_id);
      return errorResult("cancelled by user", 499);
    }
    deps.setProjectRecordedStatus(project.id, "error", project.container_id);
    const rawMessage = e instanceof Error ? e.message : "Unknown error";
    const message = redactCredentialsInText(rawMessage);
    console.error(`[build] FAILED: ${message}`);
    run.appendStderr(`${message}\n`);
    run.finalize(1);
    return buildErrorResult(message);
  }
}

export async function startProject(
  project: Project,
  partialDeps?: Partial<DeployDeps>,
): Promise<ProjectActionResult> {
  const deps = makeDeployDeps(partialDeps);

  return withProjectLifecycleLocks(project, async () => {
    // #79: drain-mode gate. Starting a container is "new work" from
    // moor's perspective - same gate as deploy/build. Stop/logs stay
    // open so operators can quiesce things during drain.
    const drained = deps.requireNotDraining();
    if (drained) return { kind: "response", response: drained };

    const currentProject = refreshProjectLifecycleState(project, deps);
    if (!currentProject) return errorResult("Not found", 404);
    return startProjectAfterDrainCheck(currentProject, deps);
  });
}

async function startProjectAfterDrainCheck(
  project: Project,
  deps: DeployDeps,
): Promise<ProjectActionResult> {
  console.log(`[start] project=${project.name} image=${project.image_tag}`);
  if (!project.image_tag) {
    console.log("[start] rejected — no image built");
    return errorResult("No image built yet", 400);
  }

  const envs = deps.listEnvVars(project.id);
  const ports = deps.getProjectPorts(project.id);
  console.log(
    `[start] creating container moor-${project.name} with ${envs.length} env vars and ${ports.length} ports`,
  );

  try {
    const config = buildContainerStartConfig(project, deps, envs, ports);
    const containerId = await deps.createAndStartContainer(
      project.image_tag,
      `moor-${project.name}`,
      config.envs,
      config.ports,
      project.restart_policy,
      { memoryLimitMb: project.memory_limit_mb, cpus: project.cpus },
      config.volumes,
      config.labels,
      config.extras,
    );
    console.log(`[start] container started: ${containerId}`);
    deps.updateProjectContainerId(project.id, containerId);
    deps.setProjectRecordedStatus(project.id, "running", containerId);

    if (project.domain) {
      await deps.syncCaddyRoutes();
    }

    return { kind: "json", body: { message: "Container started" } };
  } catch (e) {
    deps.setProjectRecordedStatus(project.id, "error", project.container_id);
    const message = e instanceof Error ? e.message : "Unknown error";
    console.error(`[start] FAILED: ${message}`);
    return errorResult(message, 500);
  }
}

export async function restartProject(
  project: Project,
  partialDeps?: Partial<DeployDeps>,
  input: RestartProjectInput = {},
): Promise<ProjectActionResult> {
  const deps = makeDeployDeps(partialDeps);

  const restartLifecycle = async (): Promise<ProjectActionResult> => {
    const currentProject = refreshProjectLifecycleState(project, deps);
    if (!currentProject) return errorResult("Not found", 404);

    // A restart is new container work. Refuse it before stopping the current
    // container so drain mode cannot turn a safe rejection into downtime.
    const drained = deps.requireNotDraining();
    if (drained) return { kind: "response", response: drained };

    // startProject validates this too, but restart must validate before stop.
    if (!currentProject.image_tag) return errorResult("No image built yet", 400);

    await stopProjectAfterLifecycleLock(currentProject, deps);
    const started = await startProjectAfterDrainCheck(currentProject, deps);
    if (started.kind !== "json" || (started.status !== undefined && started.status >= 400)) {
      return started;
    }

    return { kind: "json", body: { message: "Container restarted" } };
  };

  return input.lifecycleLockHeld
    ? restartLifecycle()
    : withProjectLifecycleLocks(project, restartLifecycle);
}

export async function stopProject(
  project: Project,
  partialDeps?: Partial<DeployDeps>,
): Promise<ProjectActionResult> {
  const deps = makeDeployDeps(partialDeps);

  return withProjectLifecycleLocks(project, () => stopProjectAfterLifecycleLock(project, deps));
}

async function stopProjectAfterLifecycleLock(
  project: Project,
  deps: DeployDeps,
): Promise<ProjectActionResult> {
  const currentProject = refreshProjectLifecycleState(project, deps);
  if (!currentProject) return errorResult("Not found", 404);
  const containerId = currentProject.container_id;

  console.log(`[stop] project=${project.name} container=${containerId}`);
  if (!containerId) {
    console.log("[stop] no container — marking as stopped");
    deps.setProjectRecordedStatus(project.id, "stopped", containerId);
    return { kind: "json", body: { message: "Container stopped" } };
  }

  try {
    await deps.stopContainer(containerId);
    console.log("[stop] container stopped");
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    console.error(`[stop] error during stop (marking as stopped anyway): ${message}`);
  }

  deps.setProjectRecordedStatus(project.id, "stopped", containerId);
  return { kind: "json", body: { message: "Container stopped" } };
}
