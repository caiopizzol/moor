import { existsSync } from "node:fs";
import { homedir } from "node:os";

function findSocket(): string {
  if (process.env.DOCKER_HOST) return process.env.DOCKER_HOST.replace("unix://", "");
  // Standard Linux path (Docker on VM / Linux host)
  if (existsSync("/var/run/docker.sock")) return "/var/run/docker.sock";
  // macOS Docker Desktop path
  return `${homedir()}/.docker/run/docker.sock`;
}

export const SOCKET = findSocket();

const BUILD_TIMEOUT = 1_800_000; // 30 minutes

async function dockerFetch(
  path: string,
  opts?: RequestInit & { timeout?: number },
): Promise<Response> {
  const { timeout = 30000, signal, ...init } = opts ?? {};
  const timeoutSignal = AbortSignal.timeout(timeout);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  console.log(`[docker-api] ${init.method || "GET"} ${path}`);
  const res = await fetch(`http://localhost${path}`, {
    ...init,
    unix: SOCKET,
    signal: combinedSignal,
  });
  console.log(`[docker-api] → ${res.status} ${res.statusText}`);
  return res;
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

export async function buildImage(
  githubUrl: string,
  branch: string,
  dockerfile: string,
  tag: string,
): Promise<string> {
  const gitUrl = githubUrl.endsWith(".git") ? githubUrl : `${githubUrl}.git`;
  const remote = `${gitUrl}#${branch}`;
  const params = new URLSearchParams({ remote, t: tag, dockerfile });
  console.log(`[buildImage] remote=${remote} tag=${tag} dockerfile=${dockerfile}`);
  const res = await dockerFetch(`/v1.44/build?${params}`, {
    method: "POST",
    timeout: BUILD_TIMEOUT,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Docker build failed: ${res.status} ${body}`);
  }

  let rawOutput = "";
  const reader = res.body?.getReader();
  if (reader) {
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      rawOutput += decoder.decode(value, { stream: true });
    }
  }

  let buildError: string | null = null;
  let output = "";
  for (const line of rawOutput.split("\n").filter(Boolean)) {
    const parsed = parseBuildLine(line);
    if (parsed) {
      output += parsed.text;
      if (parsed.error) buildError = parsed.text;
    }
  }

  if (buildError) throw new Error(buildError);
  return output;
}

/** Streaming version of buildImage — calls onLine for each parsed line as it arrives. */
export async function buildImageStreaming(
  githubUrl: string,
  branch: string,
  dockerfile: string,
  tag: string,
  onLine: (text: string) => void,
  noCache = false,
): Promise<string> {
  const gitUrl = githubUrl.endsWith(".git") ? githubUrl : `${githubUrl}.git`;
  const remote = `${gitUrl}#${branch}`;
  const params = new URLSearchParams({ remote, t: tag, dockerfile });
  if (noCache) params.set("nocache", "true");
  console.log(
    `[buildImageStreaming] remote=${remote} tag=${tag} dockerfile=${dockerfile} nocache=${noCache}`,
  );
  const res = await dockerFetch(`/v1.44/build?${params}`, {
    method: "POST",
    timeout: BUILD_TIMEOUT,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Docker build failed: ${res.status} ${body}`);
  }

  let buildError: string | null = null;
  let output = "";
  let buffer = "";
  const reader = res.body?.getReader();
  if (!reader) return "";

  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Process complete lines
    const lines = buffer.split("\n");
    buffer = lines.pop() || ""; // keep incomplete line in buffer
    for (const line of lines) {
      if (!line) continue;
      const parsed = parseBuildLine(line);
      if (parsed) {
        output += parsed.text;
        onLine(parsed.text);
        if (parsed.error) buildError = parsed.text;
      }
    }
  }
  // Process remaining buffer
  if (buffer) {
    const parsed = parseBuildLine(buffer);
    if (parsed) {
      output += parsed.text;
      onLine(parsed.text);
      if (parsed.error) buildError = parsed.text;
    }
  }

  if (buildError) throw new Error(buildError);
  return output;
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

/** Pull a Docker image with streaming output. */
export async function pullImageStreaming(
  imageRef: string,
  onLine: (text: string) => void,
): Promise<string> {
  // Split image:tag
  const [fromImage, tag] = imageRef.includes(":")
    ? [imageRef.slice(0, imageRef.lastIndexOf(":")), imageRef.slice(imageRef.lastIndexOf(":") + 1)]
    : [imageRef, "latest"];

  const params = new URLSearchParams({ fromImage, tag });

  // Explicitly set platform to avoid manifest parsing failures on multi-arch images
  try {
    const versionRes = await dockerFetch("/v1.44/version");
    if (versionRes.ok) {
      const version = (await versionRes.json()) as { Os: string; Arch: string };
      params.set("platform", `${version.Os}/${version.Arch}`);
    }
  } catch {
    // Fall back to no platform — let Docker decide
  }

  console.log(
    `[pullImageStreaming] fromImage=${fromImage} tag=${tag} platform=${params.get("platform") ?? "auto"}`,
  );

  const res = await dockerFetch(`/v1.44/images/create?${params}`, {
    method: "POST",
    timeout: BUILD_TIMEOUT,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Docker pull failed: ${res.status} ${body}`);
  }

  let pullError: string | null = null;
  let output = "";
  let buffer = "";
  const reader = res.body?.getReader();
  if (!reader) return "";

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
        output += parsed.text;
        onLine(parsed.text);
        if (parsed.error) pullError = parsed.text;
      }
    }
  }
  if (buffer) {
    const parsed = parsePullLine(buffer);
    if (parsed) {
      output += parsed.text;
      onLine(parsed.text);
      if (parsed.error) pullError = parsed.text;
    }
  }

  if (pullError) throw new Error(pullError);
  return output;
}

export async function createAndStartContainer(
  imageTag: string,
  name: string,
  envVars: { key: string; value: string }[],
  ports: { host_port: number; container_port: number }[] = [],
  restartPolicy = "unless-stopped",
): Promise<string> {
  console.log(
    `[createContainer] image=${imageTag} name=${name} envVars=${envVars.length} ports=${ports.length}`,
  );
  // Remove existing container with this name if it exists
  try {
    console.log(`[createContainer] removing existing container ${name}...`);
    await dockerFetch(`/v1.44/containers/${name}?force=true`, { method: "DELETE" });
  } catch {
    console.log("[createContainer] no existing container to remove");
  }

  // Build port bindings for Docker API
  const exposedPorts: Record<string, object> = {};
  const portBindings: Record<string, { HostPort: string }[]> = {};
  for (const { host_port, container_port } of ports) {
    const key = `${container_port}/tcp`;
    exposedPorts[key] = {};
    portBindings[key] = [{ HostPort: String(host_port) }];
  }

  const body = {
    Image: imageTag,
    Env: envVars.map((e) => `${e.key}=${e.value}`),
    ExposedPorts: exposedPorts,
    HostConfig: {
      RestartPolicy: { Name: restartPolicy },
      PortBindings: portBindings,
    },
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

  // Connect to moor_default network so Caddy can reach the container
  try {
    await dockerFetch("/v1.44/networks/moor_default/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ Container: Id }),
    });
    console.log(`[createContainer] connected ${name} to moor_default`);
  } catch {
    // Network may not exist in dev environments
    console.warn("[createContainer] moor_default network connect skipped");
  }

  const startRes = await dockerFetch(`/v1.44/containers/${Id}/start`, { method: "POST" });
  if (!startRes.ok && startRes.status !== 304) {
    const err = await startRes.text();
    throw new Error(`Container start failed: ${err}`);
  }

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
  if (!res.ok && res.status !== 404) {
    const err = await res.text();
    console.error(`[removeContainer] error: ${err}`);
  }
}

export async function execInContainer(
  containerId: string,
  command: string,
  opts?: { signal?: AbortSignal; onExecId?: (id: string) => void },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  console.log(`[execInContainer] container=${containerId.slice(0, 12)} cmd="${command}"`);
  // Create exec
  const createRes = await dockerFetch(`/v1.44/containers/${containerId}/exec`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      Cmd: ["sh", "-c", command],
      AttachStdout: true,
      AttachStderr: true,
    }),
  });

  if (!createRes.ok) throw new Error(`Exec create failed: ${await createRes.text()}`);
  const { Id } = (await createRes.json()) as { Id: string };

  // Expose exec ID to caller before blocking start
  opts?.onExecId?.(Id);

  // Start exec
  const startRes = await dockerFetch(`/v1.44/exec/${Id}/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ Detach: false }),
    timeout: 600000,
    signal: opts?.signal,
  });

  if (!startRes.ok) throw new Error(`Exec start failed: ${await startRes.text()}`);

  // Read multiplexed stream
  const raw = new Uint8Array(await startRes.arrayBuffer());
  let stdout = "";
  let stderr = "";
  const decoder = new TextDecoder();

  let offset = 0;
  while (offset + 8 <= raw.length) {
    const streamType = raw[offset]; // 1=stdout, 2=stderr
    const size =
      (raw[offset + 4] << 24) | (raw[offset + 5] << 16) | (raw[offset + 6] << 8) | raw[offset + 7];
    offset += 8;
    const chunk = decoder.decode(raw.slice(offset, offset + size));
    if (streamType === 1) stdout += chunk;
    else if (streamType === 2) stderr += chunk;
    offset += size;
  }

  // Inspect exec for exit code
  const inspectRes = await dockerFetch(`/v1.44/exec/${Id}/json`);
  const inspect = (await inspectRes.json()) as { ExitCode: number };

  return { exitCode: inspect.ExitCode, stdout, stderr };
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

export async function getContainerLogs(
  containerId: string,
  opts: { tail?: number; since?: number } = {},
): Promise<{ logs: string; lastTimestamp: number }> {
  const params = new URLSearchParams({
    stdout: "true",
    stderr: "true",
    timestamps: "true",
  });
  if (opts.tail !== undefined) params.set("tail", String(opts.tail));
  if (opts.since !== undefined) params.set("since", String(opts.since));
  const res = await dockerFetch(`/v1.44/containers/${containerId}/logs?${params}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Container logs failed: ${res.status} ${body}`);
  }

  // Docker returns multiplexed stream — strip 8-byte frame headers
  const raw = new Uint8Array(await res.arrayBuffer());
  const decoder = new TextDecoder();
  let output = "";
  let offset = 0;
  while (offset + 8 <= raw.length) {
    const size =
      (raw[offset + 4] << 24) | (raw[offset + 5] << 16) | (raw[offset + 6] << 8) | raw[offset + 7];
    offset += 8;
    output += decoder.decode(raw.slice(offset, offset + size));
    offset += size;
  }

  // Strip Docker timestamps from each line and track the latest one
  let lastTimestamp = opts.since || 0;
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

export async function killExec(execId: string): Promise<void> {
  const data = await inspectExec(execId);
  if (!data?.Running) return;
  // Note: process.kill with the host PID only works when running outside Docker
  // or with pid:host. Inside a container this is best-effort.
  if (data.Pid > 0) {
    try {
      process.kill(data.Pid, "SIGKILL");
    } catch {
      // Process already gone or PID not visible from this namespace
    }
  }
}
