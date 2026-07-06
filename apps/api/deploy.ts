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
  | { kind: "text"; body: string; status: number }
  | { kind: "json"; body: unknown; status?: number }
  | { kind: "stream"; stream: ReadableStream<Uint8Array> };

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

function resolverFailureResult(failure: ResolveFailure): ProjectActionResult {
  return { kind: "json", body: failure, status: 400 };
}

/** Build the /build catch-path response from an already-redacted error
 *  message. Classified auth failures (#119) become 401 JSON with a
 *  structured code so agents can branch; unclassified errors keep the
 *  legacy 500/text contract so existing UI clients are unaffected. */
export function buildErrorResponse(message: string): Response {
  const code = classifyBuildError(message);
  if (code !== "unknown") {
    return Response.json({ code, message }, { status: 401 });
  }
  return new Response(message, { status: 500 });
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
  return { kind: "text", body: message, status: 500 };
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
  input: { noCache: boolean },
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
      return startProject(project, deps);
    }
    console.log("[run] no source or image_tag — nothing to do");
    return { kind: "text", body: "No GitHub URL or Docker image configured", status: 400 };
  }

  if (project.github_url) {
    const urlError = validateGithubUrl(project.github_url);
    if (urlError) return { kind: "text", body: urlError, status: 400 };
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
  deps.setProjectRecordedStatus(project.id, status, project.container_id);

  // #65: one deploy run row covers build/pull + port detection + container
  // start. INSERT before the build starts so moor_run_get can tail mid-build;
  // BuildRun periodically flushes the rolling tail into runs.stdout.
  const run = deps.createBuildRun(project.id);

  // Stream build/pull output via SSE
  let streamClosed = false;
  let keepalive: ReturnType<typeof setInterval> | null = null;
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

      // Mirror every log line into both the SSE stream (for the UI/CLI) and
      // the persistent BuildRun (for moor_run_get). Single source of text.
      const log = (line: string) => {
        send("log", line);
        run.appendStdout(line);
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
        deps.setProjectRecordedStatus(project.id, "stopped", project.container_id);

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
          await deps.reconcileProjectStatusAfterInterrupt(project.id, project.container_id);
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
        deps.setProjectRecordedStatus(project.id, "error", project.container_id);
        for (const ev of buildErrorEvents(message)) send(ev.event, ev.data);
        safeClose();
        return;
      }

      // Container start is part of the same deploy run - operator's
      // mental model is "rebuild" includes "and is now running."
      try {
        log("Starting container...\n");
        const containerId = await createStartAndRecord(project, tag, deps);
        console.log(`[run] container started: ${containerId}`);

        if (project.domain) {
          log(`Route: ${project.domain} -> :${project.domain_port}\n`);
        }

        run.finalize(0);
        send("done", "Container started");
      } catch (e) {
        deps.setProjectRecordedStatus(project.id, "error", project.container_id);
        const message = e instanceof Error ? e.message : "Unknown error";
        console.error(`[run] CONTAINER START FAILED: ${message}`);
        run.appendStderr(`${message}\n`);
        run.finalize(1);
        send("error", message);
      }

      safeClose();
    },
    cancel() {
      if (keepalive !== null) clearInterval(keepalive);
      streamClosed = true;
      // If the client disconnects mid-build the build still runs to
      // completion on the daemon and finalize() will fire from the build
      // try/catch above. No need to finalize here.
    },
  });

  return { kind: "stream", stream };
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
    return { kind: "text", body: "No GitHub URL configured", status: 400 };
  }
  const urlError = validateGithubUrl(project.github_url);
  if (urlError) return { kind: "text", body: urlError, status: 400 };

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
      return { kind: "text", body: "cancelled by user", status: 499 };
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

  // #79: drain-mode gate. Starting a container is "new work" from
  // moor's perspective - same gate as deploy/build. Stop/logs stay
  // open so operators can quiesce things during drain.
  const drained = deps.requireNotDraining();
  if (drained) return { kind: "response", response: drained };

  console.log(`[start] project=${project.name} image=${project.image_tag}`);
  if (!project.image_tag) {
    console.log("[start] rejected — no image built");
    return { kind: "text", body: "No image built yet", status: 400 };
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
    return { kind: "text", body: message, status: 500 };
  }
}

export async function stopProject(
  project: Project,
  partialDeps?: Partial<DeployDeps>,
): Promise<ProjectActionResult> {
  const deps = makeDeployDeps(partialDeps);

  console.log(`[stop] project=${project.name} container=${project.container_id}`);
  if (!project.container_id) {
    console.log("[stop] no container — marking as stopped");
    deps.setProjectRecordedStatus(project.id, "stopped", project.container_id);
    return { kind: "json", body: { message: "Container stopped" } };
  }

  try {
    await deps.stopContainer(project.container_id);
    console.log("[stop] container stopped");
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    console.error(`[stop] error during stop (marking as stopped anyway): ${message}`);
  }

  deps.setProjectRecordedStatus(project.id, "stopped", project.container_id);
  return { kind: "json", body: { message: "Container stopped" } };
}
