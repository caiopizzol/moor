import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { createFrameParser } from "./docker-frame-parser";
import { buildKillScript, buildWrappedExecCmd, parseKillResult } from "./exec-kill";
import { parseImageRef } from "./image-ref";
import { redactCredentials, redactCredentialsInText, redactDockerBuildPath } from "./redact";
import { buildPullAuthHeaders } from "./registry-auth";
import { getCredentialByHostname } from "./registry-credentials-db";

function findSocket(): string {
  if (process.env.DOCKER_HOST) return process.env.DOCKER_HOST.replace("unix://", "");
  // Standard Linux path (Docker on VM / Linux host)
  if (existsSync("/var/run/docker.sock")) return "/var/run/docker.sock";
  // macOS Docker Desktop path
  return `${homedir()}/.docker/run/docker.sock`;
}

export const SOCKET = findSocket();

// #131: label keys stamped on every moor-created project container, used by
// the observability event consumer to correlate Docker /events back to a
// project. Namespaced under sh.moor to avoid clashing with image/compose
// labels.
export const LABEL_PROJECT_ID = "sh.moor.project_id";
export const LABEL_PROJECT_NAME = "sh.moor.project_name";

/** Build the moor container-label set for a project. */
export function projectLabels(projectId: number, projectName: string): Record<string, string> {
  return {
    [LABEL_PROJECT_ID]: String(projectId),
    [LABEL_PROJECT_NAME]: projectName,
  };
}

const BUILD_TIMEOUT = 1_800_000; // 30 minutes

async function dockerFetch(
  path: string,
  opts?: RequestInit & { timeout?: number },
): Promise<Response> {
  const { timeout = 30000, signal, ...init } = opts ?? {};
  // `timeout: 0` disables the internal safety timer. The caller's `signal` is
  // then the only abort path. Used by execInContainer for /exec/start, where
  // the exec may legitimately run for an operator-supplied timeout_ms greater
  // than 30s — letting dockerFetch fire its own 30s timer would silently
  // truncate long execs before the kill flow could run. Phase B (async exec)
  // needs the same opt-out for jobs that can take hours.
  const timeoutSignal = timeout > 0 ? AbortSignal.timeout(timeout) : null;
  let combinedSignal: AbortSignal | undefined;
  if (signal && timeoutSignal) {
    combinedSignal = AbortSignal.any([signal, timeoutSignal]);
  } else {
    combinedSignal = signal ?? timeoutSignal ?? undefined;
  }
  console.log(`[docker-api] ${init.method || "GET"} ${redactDockerBuildPath(path)}`);
  const res = await fetch(`http://localhost${path}`, {
    ...init,
    unix: SOCKET,
    signal: combinedSignal,
  });
  console.log(`[docker-api] → ${res.status} ${res.statusText}`);
  return res;
}

/** Resolve the compose project name by inspecting moor's own container labels.
 *  Docker sets HOSTNAME to the container short ID by default. Cached lazily. */
let cachedProject: string | null = null;
export async function getComposeProject(): Promise<string> {
  if (cachedProject) return cachedProject;
  const hostname = process.env.HOSTNAME;
  if (!hostname) throw new Error("HOSTNAME env var is empty - cannot self-inspect");
  const res = await dockerFetch(`/v1.44/containers/${hostname}/json`);
  if (!res.ok) {
    throw new Error(`Self-inspect failed (status ${res.status}); not running under compose?`);
  }
  const data = (await res.json()) as { Config?: { Labels?: Record<string, string> } };
  const project = data.Config?.Labels?.["com.docker.compose.project"];
  if (!project) {
    throw new Error("com.docker.compose.project label missing on self");
  }
  cachedProject = project;
  return project;
}

/** Find the Caddy container by compose labels for the current project.
 *  Returns the container ID. Throws if not found. */
export async function findCaddyContainerId(): Promise<string> {
  const project = await getComposeProject();
  const filters = JSON.stringify({
    label: [`com.docker.compose.project=${project}`, "com.docker.compose.service=caddy"],
  });
  const res = await dockerFetch(`/v1.44/containers/json?filters=${encodeURIComponent(filters)}`);
  if (!res.ok) throw new Error(`Container list failed: ${res.status}`);
  const containers = (await res.json()) as Array<{ Id: string }>;
  if (containers.length === 0) {
    throw new Error(`No caddy container found for compose project "${project}"`);
  }
  return containers[0].Id;
}

/** Find the default compose network for the current project.
 *  Returns the network name (suitable for /networks/{name}/connect). */
export async function findDefaultNetworkName(): Promise<string> {
  const project = await getComposeProject();
  const filters = JSON.stringify({
    label: [`com.docker.compose.project=${project}`, "com.docker.compose.network=default"],
  });
  const res = await dockerFetch(`/v1.44/networks?filters=${encodeURIComponent(filters)}`);
  if (!res.ok) throw new Error(`Network list failed: ${res.status}`);
  const networks = (await res.json()) as Array<{ Name: string }>;
  if (networks.length === 0) {
    throw new Error(`No default compose network found for project "${project}"`);
  }
  return networks[0].Name;
}

/** Parse a single Docker JSON build line into clean text. Returns null if nothing to display. */
function parseBuildLine(line: string): { text: string; error?: boolean } | null {
  try {
    const parsed = JSON.parse(line);
    if (parsed.error) return { text: `ERROR: ${parsed.error}\n`, error: true };
    if (parsed.stream) return { text: parsed.stream };
    if (parsed.aux?.ID) return { text: `Built image: ${parsed.aux.ID.slice(0, 19)}\n` };
    // Docker pull progress (e.g. "Pulling from library/golang", "Downloading", "Extracting")
    if (parsed.status) {
      const id = parsed.id ? `${parsed.id}: ` : "";
      // Skip noisy per-layer progress bars, show status changes only
      if (parsed.progress) return null;
      return { text: `${id}${parsed.status}\n` };
    }
  } catch {
    return { text: `${line}\n` };
  }
  return null;
}

/** Build a Docker image. Calls onLine for each parsed line as it arrives.
 *  Returns void: callers own persistence (see BuildRun in
 *  apps/api/build-runs.ts). An earlier full-string return value kept an
 *  unbounded copy of the build log alive in API memory, which defeated
 *  the 64 KiB tail cap on the durable side.
 *
 *  Credential redaction: cloneUrl may carry user:pass@ (resolved in the
 *  route layer from a source_credential_id, or a legacy embedded URL).
 *  Every emitted text — stream lines, the thrown error, and the non-OK
 *  response body — is run through redactCredentialsInText before
 *  leaving this function. Docker still sees the credentialed URL on
 *  the wire because that's what authenticates the clone. */
export async function buildImageStreaming(
  cloneUrl: string,
  branch: string,
  dockerfile: string,
  tag: string,
  onLine: (text: string) => void,
  noCache = false,
  signal?: AbortSignal,
): Promise<void> {
  const gitUrl = cloneUrl.endsWith(".git") ? cloneUrl : `${cloneUrl}.git`;
  const remote = `${gitUrl}#${branch}`;
  const params = new URLSearchParams({ remote, t: tag, dockerfile });
  if (noCache) params.set("nocache", "true");
  console.log(
    `[buildImageStreaming] remote=${redactCredentials(remote) ?? remote} tag=${tag} dockerfile=${dockerfile} nocache=${noCache}`,
  );
  // #68: signal lets BuildRun.cancel() tear down the daemon-side build.
  // Live test confirmed closing the /v1.44/build connection aborts the
  // build immediately (classic builder; BuildKit untested).
  const res = await dockerFetch(`/v1.44/build?${params}`, {
    method: "POST",
    timeout: BUILD_TIMEOUT,
    signal,
  });

  if (!res.ok) {
    const body = await res.text();
    // Docker may echo the remote URL in the body; redact before throwing.
    throw new Error(redactCredentialsInText(`Docker build failed: ${res.status} ${body}`));
  }

  // Every text crossing onLine and the final throw goes through this
  // redactor: Docker daemon error frames frequently include the remote
  // URL ("fatal: Authentication failed for 'https://x:tok@github.com/...'").
  const safeEmit = (text: string): void => onLine(redactCredentialsInText(text));

  let buildError: string | null = null;
  let buffer = "";
  const reader = res.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line) continue;
      const parsed = parseBuildLine(line);
      if (parsed) {
        safeEmit(parsed.text);
        if (parsed.error) buildError = parsed.text;
      }
    }
  }
  if (buffer) {
    const parsed = parseBuildLine(buffer);
    if (parsed) {
      safeEmit(parsed.text);
      if (parsed.error) buildError = parsed.text;
    }
  }

  if (buildError) throw new Error(redactCredentialsInText(buildError));
}

/** Parse a single Docker pull JSON line into display text. */
function parsePullLine(line: string): { text: string; error?: boolean } | null {
  try {
    const parsed = JSON.parse(line);
    if (parsed.error) return { text: `ERROR: ${parsed.error}\n`, error: true };
    if (parsed.status) {
      const id = parsed.id ? `${parsed.id}: ` : "";
      // Skip noisy per-layer progress bars, show status changes only
      if (parsed.progress) return null;
      return { text: `${id}${parsed.status}\n` };
    }
  } catch {
    return { text: `${line}\n` };
  }
  return null;
}

/** Pull a Docker image with streaming output. Returns void: callers own
 *  persistence (see BuildRun). Same rationale as buildImageStreaming. */
export async function pullImageStreaming(
  imageRef: string,
  onLine: (text: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const parsed = parseImageRef(imageRef);
  const params = new URLSearchParams();
  params.set("fromImage", parsed.fromImage);
  if (parsed.tag !== null) params.set("tag", parsed.tag);

  // Explicitly set platform to avoid manifest parsing failures on multi-arch images.
  // /version is called anonymously: no registry credential involved.
  try {
    const versionRes = await dockerFetch("/v1.44/version");
    if (versionRes.ok) {
      const version = (await versionRes.json()) as { Os: string; Arch: string };
      params.set("platform", `${version.Os}/${version.Arch}`);
    }
  } catch {
    // Fall back to no platform — let Docker decide
  }

  // Look up a credential by the registry host extracted from the ref.
  // No match → no header → anonymous pull (preserves today's public-image behavior).
  const credential = getCredentialByHostname(parsed.registryHost);
  const authHeaders = buildPullAuthHeaders(parsed, credential);

  console.log(
    `[pullImageStreaming] fromImage=${parsed.fromImage} tag=${parsed.tag ?? "(digest)"} platform=${params.get("platform") ?? "auto"} auth=${credential ? `host=${parsed.registryHost}` : "anonymous"}`,
  );

  const res = await dockerFetch(`/v1.44/images/create?${params}`, {
    method: "POST",
    headers: authHeaders,
    timeout: BUILD_TIMEOUT,
    signal,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Docker pull failed: ${res.status} ${body}`);
  }

  let pullError: string | null = null;
  let buffer = "";
  const reader = res.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line) continue;
      const parsed = parsePullLine(line);
      if (parsed) {
        onLine(parsed.text);
        if (parsed.error) pullError = parsed.text;
      }
    }
  }
  if (buffer) {
    const parsed = parsePullLine(buffer);
    if (parsed) {
      onLine(parsed.text);
      if (parsed.error) pullError = parsed.text;
    }
  }

  if (pullError) throw new Error(pullError);
}

/** #134: run `start` for a just-created container, removing the container if it
 *  throws. createAndStartContainer creates the container before this runs but
 *  only persists container_id after it returns, so a network-attach or start
 *  failure here would otherwise orphan a `Created` container that project
 *  delete can't reap. Cleanup is best-effort and never masks the original
 *  error — the start/connect failure is always what propagates. `remove` is
 *  injectable for tests; production uses removeContainer (force DELETE, treats
 *  404 as already-gone, throws on other failures so the cleanup log is
 *  truthful about whether the orphan was actually removed). */
export async function startOrCleanup(
  id: string,
  start: () => Promise<void>,
  remove: (id: string) => Promise<void> = removeContainer,
): Promise<void> {
  try {
    await start();
  } catch (startErr) {
    try {
      await remove(id);
      console.warn(
        `[createContainer] removed orphaned container ${id.slice(0, 12)} after start/connect failure`,
      );
    } catch (cleanupErr) {
      const m = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
      console.warn(
        `[createContainer] could not remove container ${id.slice(0, 12)} after start/connect failure: ${m} (original error preserved)`,
      );
    }
    throw startErr;
  }
}

export async function createAndStartContainer(
  imageTag: string,
  name: string,
  envVars: { key: string; value: string }[],
  ports: { host_port: number; container_port: number }[] = [],
  restartPolicy = "unless-stopped",
  limits: { memoryLimitMb?: number | null; cpus?: number | null } = {},
  volumes: Array<{ docker_name: string; target: string }> = [],
  labels: Record<string, string> = {},
): Promise<string> {
  console.log(
    `[createContainer] image=${imageTag} name=${name} envVars=${envVars.length} ports=${ports.length} mem_mb=${limits.memoryLimitMb ?? ""} cpus=${limits.cpus ?? ""} volumes=${volumes.length}`,
  );
  // Remove existing container with this name if it exists
  try {
    console.log(`[createContainer] removing existing container ${name}...`);
    await dockerFetch(`/v1.44/containers/${name}?force=true`, { method: "DELETE" });
  } catch {
    console.log("[createContainer] no existing container to remove");
  }

  // Build port bindings for Docker API. Bind to loopback so project containers
  // are reachable from inside the VM for local debugging but not from the public
  // internet. Caddy reaches them over the internal compose default network using
  // Docker DNS, not via host ports, so this does not affect domain routing.
  const exposedPorts: Record<string, object> = {};
  const portBindings: Record<string, { HostIp: string; HostPort: string }[]> = {};
  for (const { host_port, container_port } of ports) {
    const key = `${container_port}/tcp`;
    exposedPorts[key] = {};
    portBindings[key] = [{ HostIp: "127.0.0.1", HostPort: String(host_port) }];
  }

  // #36: per-project memory and CPU limits. Setting Memory and MemorySwap to
  // the same value gives the container a hard memory cap with no swap headroom
  // — without this, a memory-limited container could still page heavily into
  // host swap. NanoCpus is Docker's cgroup CPU quota (cpus * 1e9 = nanoseconds
  // of CPU time per second).
  const hostConfig: Record<string, unknown> = {
    RestartPolicy: { Name: restartPolicy },
    PortBindings: portBindings,
  };
  if (limits.memoryLimitMb != null) {
    const bytes = limits.memoryLimitMb * 1024 * 1024;
    hostConfig.Memory = bytes;
    hostConfig.MemorySwap = bytes;
  }
  if (limits.cpus != null) {
    hostConfig.NanoCpus = Math.round(limits.cpus * 1e9);
  }

  // #35: named-volume mounts. Type "volume" means Docker manages the volume
  // lifecycle (auto-creates on first reference if missing) and stores data
  // under /var/lib/docker/volumes/<name>. docker_name is what we stored at
  // config-creation time so renaming the project doesn't lose the data.
  if (volumes.length > 0) {
    hostConfig.Mounts = volumes.map((v) => ({
      Type: "volume",
      Source: v.docker_name,
      Target: v.target,
    }));
  }

  // #131: container labels for observability event correlation. Top-level
  // sibling of HostConfig (Docker's create body puts Labels at the config
  // level, not under HostConfig). The Docker /events consumer reads these from
  // each event's Actor.Attributes to map a container back to its project
  // without a timing-sensitive container_id round-trip.
  const body = {
    Image: imageTag,
    Env: envVars.map((e) => `${e.key}=${e.value}`),
    ExposedPorts: exposedPorts,
    Labels: labels,
    HostConfig: hostConfig,
  };

  const createRes = await dockerFetch(`/v1.44/containers/create?name=${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!createRes.ok) {
    const err = await createRes.text();
    throw new Error(`Container create failed: ${err}`);
  }

  const { Id } = (await createRes.json()) as { Id: string };

  // Connect to the compose default network so Caddy can reach the container.
  // Resolved by compose labels (not hardcoded).
  //
  // We only soft-skip the dev-mode case (moor running outside compose, so
  // self-inspect fails). Once we know moor IS under compose, any failure in
  // the network list or the attach itself is a real production error and
  // propagates - otherwise we'd be starting a container Caddy cannot reach.
  let underCompose = false;
  try {
    await getComposeProject();
    underCompose = true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[createContainer] not running under compose; skipping network attach: ${msg}`);
  }
  // #134: the container now EXISTS in Docker, but container_id is only
  // persisted on the project row AFTER this function returns. So any failure
  // attaching the network or starting it must remove the orphan here —
  // otherwise it lingers in `Created` state and project delete can't reap it
  // (the row has container_id = NULL). Cleanup is best-effort and never masks
  // the original failure.
  await startOrCleanup(Id, async () => {
    if (underCompose) {
      const networkName = await findDefaultNetworkName();
      const connectRes = await dockerFetch(
        `/v1.44/networks/${encodeURIComponent(networkName)}/connect`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ Container: Id }),
        },
      );
      if (!connectRes.ok) {
        const detail = await connectRes.text();
        // Docker returns 403 with "endpoint with name X already exists" or
        // "Container already attached" when the container is already on this
        // network. Treat that case as success; everything else is a real error.
        const alreadyConnected =
          connectRes.status === 403 && /already|endpoint .* exists/i.test(detail);
        if (!alreadyConnected) {
          throw new Error(`Network connect failed (${connectRes.status}): ${detail}`);
        }
      }
      console.log(`[createContainer] connected ${name} to ${networkName}`);
    }

    const startRes = await dockerFetch(`/v1.44/containers/${Id}/start`, { method: "POST" });
    if (!startRes.ok && startRes.status !== 304) {
      const err = await startRes.text();
      throw new Error(`Container start failed: ${err}`);
    }
  });

  return Id;
}

export async function stopContainer(containerId: string): Promise<void> {
  console.log(`[stopContainer] stopping ${containerId.slice(0, 12)}...`);
  const res = await dockerFetch(`/v1.44/containers/${containerId}/stop?t=10`, {
    method: "POST",
    timeout: 30000,
  });
  console.log(`[stopContainer] response: ${res.status} ${res.statusText}`);
  // 304 = already stopped, 404 = container gone — both are fine
  if (!res.ok && res.status !== 304 && res.status !== 404) {
    const err = await res.text();
    console.error(`[stopContainer] error body: ${err}`);
    throw new Error(`Container stop failed (${res.status}): ${err}`);
  }
}

export async function removeContainer(containerId: string): Promise<void> {
  console.log(`[removeContainer] removing ${containerId.slice(0, 12)}...`);
  const res = await dockerFetch(`/v1.44/containers/${containerId}?force=true`, {
    method: "DELETE",
  });
  // 404 = already gone, which is success for a force-remove. Any other non-2xx
  // is a real failure and must throw: callers wrap this in try/catch and treat
  // removal as best-effort, but they need to TELL failure from success — e.g.
  // startOrCleanup (#134) must not log "removed orphaned container" when Docker
  // actually refused the delete. (Previously this logged and returned, which
  // silently reported success.)
  if (!res.ok && res.status !== 404) {
    const err = await res.text();
    throw new Error(`removeContainer failed (${res.status}): ${err}`);
  }
}

/** #35: delete a Docker volume by name. Returns whether the volume was removed
 *  (or didn't exist), or an error string on failure. Used only by the explicit
 *  purge path on project delete — never by moor_volume_remove. */
export async function removeVolume(
  name: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  console.log(`[removeVolume] removing ${name}`);
  const del = await dockerFetch(`/v1.44/volumes/${encodeURIComponent(name)}?force=true`, {
    method: "DELETE",
  });
  if (del.ok || del.status === 404) return { ok: true };
  const text = await del.text();
  console.error(`[removeVolume] failed name=${name} status=${del.status} body=${text}`);
  return { ok: false, error: text };
}

// #34 Phase A: callers can set a per-exec timeout instead of the previous
// hardcoded 10-minute ceiling. Cron and Caddy paths keep the default; only the
// /exec route and moor_exec MCP tool forward operator-supplied values.
export const EXEC_TIMEOUT_DEFAULT_MS = 600_000;
export const EXEC_TIMEOUT_MIN_MS = 1_000;
export const EXEC_TIMEOUT_MAX_MS = 3_600_000;

// #34 Phase A.5: on timeout we must actually terminate the in-container process,
// not just close the HTTP connection. The wrapper writes the container-local PID
// to a tmp file so a sidecar exec can walk the descendant tree from that PID
// and send signals to each. The map keeps containerId + pidFile available to
// killExec, which is what cron's stopCronRun also relies on so both paths
// benefit. Note: the descendant scan is a snapshot — children forked AFTER the
// initial scan but during the grace window can escape. The post-kill /proc
// re-read covers the scanned tree, not arbitrary later orphans.
type ExecTracking = { containerId: string; pidFile: string };
const trackedExecs = new Map<string, ExecTracking>();

/** Custom error thrown by execInContainer on timeout. Surfaces the kill outcome
 *  so callers (HTTP route, MCP tool) can tell the operator whether the workload
 *  was actually stopped or just disconnected from. `live` is the count of
 *  descendants still in a non-zombie state after the kill attempt — anything
 *  greater than zero means the kill did not fully take effect. */
export class ExecTimeoutError extends Error {
  readonly timeout_ms: number;
  readonly killSentTo: string | null;
  readonly liveAfterKill: number;
  constructor(timeout_ms: number, killSentTo: string | null, liveAfterKill: number) {
    let detail: string;
    if (killSentTo === null) {
      detail =
        "could not locate process to kill — workload may still be running inside the container";
    } else if (liveAfterKill > 0) {
      detail = `kill attempted on pid ${killSentTo} but ${liveAfterKill} descendant process(es) still running`;
    } else {
      detail = `process tree terminated (pid ${killSentTo})`;
    }
    super(`Exec timed out after ${timeout_ms}ms; ${detail}`);
    this.name = "ExecTimeoutError";
    this.timeout_ms = timeout_ms;
    this.killSentTo = killSentTo;
    this.liveAfterKill = liveAfterKill;
  }
}

/** Run an unwrapped exec for internal housekeeping (kill, pidfile cleanup).
 *  Bypasses execInContainer to avoid recursion through the wrapper and the
 *  tracking map. Short timeout, no signal. */
async function execRaw(
  containerId: string,
  command: string,
  timeoutMs = 10_000,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const create = await dockerFetch(`/v1.44/containers/${containerId}/exec`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      Cmd: ["sh", "-c", command],
      AttachStdout: true,
      AttachStderr: true,
    }),
  });
  if (!create.ok) throw new Error(`Exec create failed: ${await create.text()}`);
  const { Id } = (await create.json()) as { Id: string };

  const start = await dockerFetch(`/v1.44/exec/${Id}/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ Detach: false }),
    timeout: timeoutMs,
  });
  if (!start.ok) throw new Error(`Exec start failed: ${await start.text()}`);

  const raw = new Uint8Array(await start.arrayBuffer());
  let stdout = "";
  let stderr = "";
  const decoder = new TextDecoder();
  let offset = 0;
  while (offset + 8 <= raw.length) {
    const streamType = raw[offset];
    const size =
      (raw[offset + 4] << 24) | (raw[offset + 5] << 16) | (raw[offset + 6] << 8) | raw[offset + 7];
    offset += 8;
    const chunk = decoder.decode(raw.slice(offset, offset + size));
    if (streamType === 1) stdout += chunk;
    else if (streamType === 2) stderr += chunk;
    offset += size;
  }

  const inspect = (await (await dockerFetch(`/v1.44/exec/${Id}/json`)).json()) as {
    ExitCode: number;
  };
  return { stdout, stderr, exitCode: inspect.ExitCode };
}

export async function execInContainer(
  containerId: string,
  command: string,
  opts?: { signal?: AbortSignal; onExecId?: (id: string) => void; timeout_ms?: number },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const timeout = opts?.timeout_ms ?? EXEC_TIMEOUT_DEFAULT_MS;
  const killToken = crypto.randomUUID();
  const pidFile = `/tmp/.moor-exec-${killToken}.pid`;
  console.log(
    `[execInContainer] container=${containerId.slice(0, 12)} cmd="${command}" timeout_ms=${timeout} kill_token=${killToken}`,
  );

  // Create exec with the PID-capturing wrapper
  const createRes = await dockerFetch(`/v1.44/containers/${containerId}/exec`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      Cmd: buildWrappedExecCmd(command, pidFile),
      AttachStdout: true,
      AttachStderr: true,
    }),
  });

  if (!createRes.ok) throw new Error(`Exec create failed: ${await createRes.text()}`);
  const { Id } = (await createRes.json()) as { Id: string };

  trackedExecs.set(Id, { containerId, pidFile });
  opts?.onExecId?.(Id);

  // Manage timeout ourselves so we can kill the in-container process BEFORE
  // tearing down the HTTP connection. The user's AbortSignal still works.
  const ac = new AbortController();
  const userAbort = () => ac.abort();
  opts?.signal?.addEventListener("abort", userAbort, { once: true });

  let timedOut = false;
  let killResult: { sentTo: string | null; live: number } = { sentTo: null, live: 0 };
  // Track when the timeout callback has finished computing the kill result.
  // SIGTERM from the kill often closes the user's dockerFetch before
  // `await runKill` resolves, so the main flow can reach `if (timedOut)`
  // with killResult still at its initial value — that's the bug that caused
  // "could not locate process" reports while the kill had actually worked.
  let killDoneResolve: () => void = () => {};
  const killDone = new Promise<void>((r) => {
    killDoneResolve = r;
  });
  const timeoutHandle = setTimeout(async () => {
    timedOut = true;
    try {
      killResult = await runKill(containerId, pidFile);
    } catch (e) {
      console.warn("[execInContainer] kill on timeout failed:", e);
    } finally {
      killDoneResolve();
      ac.abort();
    }
  }, timeout);

  async function timeoutError(): Promise<ExecTimeoutError> {
    await killDone;
    return new ExecTimeoutError(timeout, killResult.sentTo, killResult.live);
  }

  try {
    // timeout: 0 — we manage the abort ourselves via ac.signal (driven by our
    // own timer at `timeout` ms, which also fires the in-container kill before
    // tearing down the connection). dockerFetch's default 30s would otherwise
    // truncate any exec with timeout_ms > 30000 before the kill flow ran.
    const startRes = await dockerFetch(`/v1.44/exec/${Id}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ Detach: false }),
      signal: ac.signal,
      timeout: 0,
    });

    if (!startRes.ok) {
      if (timedOut) throw await timeoutError();
      throw new Error(`Exec start failed: ${await startRes.text()}`);
    }

    const raw = new Uint8Array(await startRes.arrayBuffer());
    if (timedOut) throw await timeoutError();

    let stdout = "";
    let stderr = "";
    const decoder = new TextDecoder();
    let offset = 0;
    while (offset + 8 <= raw.length) {
      const streamType = raw[offset]; // 1=stdout, 2=stderr
      const size =
        (raw[offset + 4] << 24) |
        (raw[offset + 5] << 16) |
        (raw[offset + 6] << 8) |
        raw[offset + 7];
      offset += 8;
      const chunk = decoder.decode(raw.slice(offset, offset + size));
      if (streamType === 1) stdout += chunk;
      else if (streamType === 2) stderr += chunk;
      offset += size;
    }

    const inspectRes = await dockerFetch(`/v1.44/exec/${Id}/json`);
    const inspect = (await inspectRes.json()) as { ExitCode: number };
    return { exitCode: inspect.ExitCode, stdout, stderr };
  } catch (e) {
    if (timedOut) throw await timeoutError();
    throw e;
  } finally {
    clearTimeout(timeoutHandle);
    opts?.signal?.removeEventListener("abort", userAbort);
    trackedExecs.delete(Id);
    // Fire-and-forget cleanup of the pidfile so /tmp doesn't accumulate after
    // normal completions. The kill path already does this on the cancel side.
    if (!timedOut) {
      execRaw(containerId, `rm -f ${pidFile}`, 5_000).catch(() => {});
    }
  }
}

async function runKill(
  containerId: string,
  pidFile: string,
): Promise<{ sentTo: string | null; live: number }> {
  // The kill script can take a few seconds (grace + verify). Give it room.
  const { stdout } = await execRaw(containerId, buildKillScript(pidFile), 15_000);
  return parseKillResult(stdout);
}

/** Streaming variant of execInContainer for #34 Phase B async exec.
 *
 *  Differences from execInContainer:
 *  - No internal timeout. Caller controls duration via opts.signal (typically
 *    a long safety timer from exec-async.ts).
 *  - Output is delivered as raw byte chunks to the supplied callbacks rather
 *    than buffered. A multi-GB job can run without accumulating in memory.
 *  - On abort/kill, returns with exitCode=null and the caller decides how to
 *    finalize the run record (timed_out, stopped, error).
 *
 *  Same as execInContainer:
 *  - Wraps the command with the PID-capturing wrapper so killExec works.
 *  - Registers in the trackedExecs map keyed by the Docker exec ID.
 *  - Cleans up the pidfile on successful completion.
 */
export async function execInContainerStreaming(
  containerId: string,
  command: string,
  callbacks: {
    onStdout: (bytes: Uint8Array) => void;
    onStderr: (bytes: Uint8Array) => void;
  },
  opts?: { signal?: AbortSignal; onExecId?: (id: string) => void },
): Promise<{ exitCode: number | null }> {
  const killToken = crypto.randomUUID();
  const pidFile = `/tmp/.moor-exec-${killToken}.pid`;
  console.log(
    `[execInContainerStreaming] container=${containerId.slice(0, 12)} cmd="${command}" kill_token=${killToken}`,
  );

  const createRes = await dockerFetch(`/v1.44/containers/${containerId}/exec`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      Cmd: buildWrappedExecCmd(command, pidFile),
      AttachStdout: true,
      AttachStderr: true,
    }),
  });
  if (!createRes.ok) throw new Error(`Exec create failed: ${await createRes.text()}`);
  const { Id } = (await createRes.json()) as { Id: string };

  trackedExecs.set(Id, { containerId, pidFile });
  opts?.onExecId?.(Id);

  let cleanCompletion = false;
  try {
    const startRes = await dockerFetch(`/v1.44/exec/${Id}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ Detach: false }),
      signal: opts?.signal,
      timeout: 0, // caller manages duration
    });
    if (!startRes.ok) throw new Error(`Exec start failed: ${await startRes.text()}`);

    const parser = createFrameParser(callbacks);
    const reader = startRes.body?.getReader();
    if (!reader) {
      // No body — short-circuit to inspect
      const inspectRes = await dockerFetch(`/v1.44/exec/${Id}/json`);
      const inspect = (await inspectRes.json()) as { ExitCode: number | null };
      cleanCompletion = true;
      return { exitCode: inspect.ExitCode };
    }

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        parser(value);
      }
    } catch (e) {
      // Abort propagates here; finalize as no-exit-code.
      if (opts?.signal?.aborted) return { exitCode: null };
      throw e;
    }

    const inspectRes = await dockerFetch(`/v1.44/exec/${Id}/json`);
    const inspect = (await inspectRes.json()) as { ExitCode: number | null };
    cleanCompletion = true;
    return { exitCode: inspect.ExitCode };
  } finally {
    trackedExecs.delete(Id);
    if (cleanCompletion) {
      execRaw(containerId, `rm -f ${pidFile}`, 5_000).catch(() => {});
    }
    // On abort/kill, the killExec script already removed the pidfile.
  }
}

export async function getImageExposedPorts(imageTag: string): Promise<number[]> {
  try {
    const res = await dockerFetch(`/v1.44/images/${encodeURIComponent(imageTag)}/json`);
    if (!res.ok) return [];
    const data = (await res.json()) as {
      Config?: { ExposedPorts?: Record<string, object> };
    };
    const exposed = data.Config?.ExposedPorts;
    if (!exposed) return [];
    return Object.keys(exposed)
      .map((k) => Number.parseInt(k, 10))
      .filter((n) => !Number.isNaN(n));
  } catch {
    return [];
  }
}

/** #74: discriminated union so callers can distinguish 404 (container
 *  missing) from other Docker failures (socket unreachable, 5xx, parse
 *  errors). The route used to collapse all of these into an empty-logs
 *  response, which made "why am I seeing nothing?" debugging
 *  impossible. */
export type LogsFetchResult =
  | { ok: true; logs: string; lastTimestamp: number }
  | { ok: false; kind: "missing" }
  | { ok: false; kind: "error"; message: string };

/** Pure: turn the Docker `/logs` framed body into clean text +
 *  lastTimestamp. Extracted so tests can hit the parser with
 *  synthesized buffers without dragging in dockerFetch. */
export function parseDockerLogsBody(
  raw: Uint8Array,
  sinceParam: number,
): { logs: string; lastTimestamp: number } {
  const decoder = new TextDecoder();
  let output = "";
  let offset = 0;
  // Docker returns a multiplexed stream — strip 8-byte frame headers.
  while (offset + 8 <= raw.length) {
    const size =
      (raw[offset + 4] << 24) | (raw[offset + 5] << 16) | (raw[offset + 6] << 8) | raw[offset + 7];
    offset += 8;
    output += decoder.decode(raw.slice(offset, offset + size));
    offset += size;
  }

  let lastTimestamp = sinceParam || 0;
  const lines = output.split("\n");
  const cleaned = lines.map((line) => {
    // Docker timestamp format: 2024-01-01T00:00:00.000000000Z <log>
    const match = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)\s(.*)/);
    if (match) {
      const ts = Math.ceil(new Date(match[1]).getTime() / 1000);
      if (ts > lastTimestamp) lastTimestamp = ts;
      return match[2];
    }
    return line;
  });
  return { logs: cleaned.join("\n"), lastTimestamp };
}

/** Injectable fetcher for tests. Default is dockerFetch; tests pass a
 *  function that returns synthetic Response objects for each branch. */
export type LogsFetcher = (path: string) => Promise<Response>;

export async function getContainerLogs(
  containerId: string,
  opts: { tail?: number; since?: number } = {},
  fetcher: LogsFetcher = dockerFetch,
): Promise<LogsFetchResult> {
  const params = new URLSearchParams({
    stdout: "true",
    stderr: "true",
    timestamps: "true",
  });
  if (opts.tail !== undefined) params.set("tail", String(opts.tail));
  if (opts.since !== undefined) params.set("since", String(opts.since));

  let res: Response;
  try {
    res = await fetcher(`/v1.44/containers/${containerId}/logs?${params}`);
  } catch (e) {
    return { ok: false, kind: "error", message: e instanceof Error ? e.message : String(e) };
  }

  if (res.status === 404) return { ok: false, kind: "missing" };
  if (!res.ok) {
    const body = await res.text();
    return { ok: false, kind: "error", message: `Container logs failed: ${res.status} ${body}` };
  }

  try {
    const raw = new Uint8Array(await res.arrayBuffer());
    return { ok: true, ...parseDockerLogsBody(raw, opts.since || 0) };
  } catch (e) {
    return {
      ok: false,
      kind: "error",
      message: `Container logs parse failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export async function inspectContainer(containerId: string): Promise<{ running: boolean }> {
  const res = await dockerFetch(`/v1.44/containers/${containerId}/json`);
  if (!res.ok) return { running: false };
  const data = (await res.json()) as { State: { Running: boolean } };
  return { running: data.State.Running };
}

export async function inspectExec(
  execId: string,
): Promise<{ Running: boolean; Pid: number } | null> {
  try {
    const res = await dockerFetch(`/v1.44/exec/${execId}/json`);
    if (!res.ok) return null;
    return (await res.json()) as { Running: boolean; Pid: number };
  } catch {
    return null;
  }
}

/** Best-effort terminate of a running exec via a sidecar exec into the same
 *  container. Replaces the old process.kill-on-host-PID approach, which never
 *  worked from inside moor's container (no shared PID namespace) and silently
 *  no-op'd. Returns whether a kill signal was actually delivered. */
export async function killExec(
  execId: string,
): Promise<{ ok: boolean; sentTo: string | null; live: number }> {
  const tracking = trackedExecs.get(execId);
  if (!tracking) {
    const data = await inspectExec(execId);
    if (!data?.Running) return { ok: true, sentTo: null, live: 0 };
    // Pre-A.5 exec or one started before this moor restart: we don't know the
    // pidfile, so we can't kill cleanly. Report honestly.
    return { ok: false, sentTo: null, live: 0 };
  }
  try {
    const result = await runKill(tracking.containerId, tracking.pidFile);
    return {
      ok: result.sentTo !== null && result.live === 0,
      sentTo: result.sentTo,
      live: result.live,
    };
  } catch {
    return { ok: false, sentTo: null, live: 0 };
  }
}
