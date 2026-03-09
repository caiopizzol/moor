import { homedir } from "node:os";

const SOCKET =
  process.env.DOCKER_HOST?.replace("unix://", "") || `${homedir()}/.docker/run/docker.sock`;

async function dockerFetch(
  path: string,
  opts?: RequestInit & { timeout?: number },
): Promise<Response> {
  const { timeout = 30000, ...init } = opts ?? {};
  console.log(`[docker-api] ${init.method || "GET"} ${path}`);
  const res = await fetch(`http://localhost${path}`, {
    ...init,
    unix: SOCKET,
    signal: AbortSignal.timeout(timeout),
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
    timeout: 300000,
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
): Promise<string> {
  const gitUrl = githubUrl.endsWith(".git") ? githubUrl : `${githubUrl}.git`;
  const remote = `${gitUrl}#${branch}`;
  const params = new URLSearchParams({ remote, t: tag, dockerfile });
  console.log(`[buildImageStreaming] remote=${remote} tag=${tag} dockerfile=${dockerfile}`);
  const res = await dockerFetch(`/v1.44/build?${params}`, {
    method: "POST",
    timeout: 300000,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Docker build failed: ${res.status} ${body}`);
  }

  let buildError: string | null = null;
  let output = "";
  let buffer = "";
  const reader = res.body?.getReader();
  if (reader) {
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
  }

  if (buildError) throw new Error(buildError);
  return output;
}

export async function createAndStartContainer(
  imageTag: string,
  name: string,
  envVars: { key: string; value: string }[],
): Promise<string> {
  console.log(`[createContainer] image=${imageTag} name=${name} envVars=${envVars.length}`);
  // Remove existing container with this name if it exists
  try {
    console.log(`[createContainer] removing existing container ${name}...`);
    await dockerFetch(`/v1.44/containers/${name}?force=true`, { method: "DELETE" });
  } catch {
    console.log("[createContainer] no existing container to remove");
  }

  const body = {
    Image: imageTag,
    Env: envVars.map((e) => `${e.key}=${e.value}`),
    HostConfig: {
      RestartPolicy: { Name: "unless-stopped" },
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

  const startRes = await dockerFetch(`/v1.44/containers/${Id}/start`, { method: "POST" });
  if (!startRes.ok && startRes.status !== 304) {
    const err = await startRes.text();
    throw new Error(`Container start failed: ${err}`);
  }

  return Id;
}

export async function stopContainer(containerId: string): Promise<void> {
  const res = await dockerFetch(`/v1.44/containers/${containerId}/stop?t=10`, { method: "POST" });
  if (!res.ok && res.status !== 304) {
    const err = await res.text();
    throw new Error(`Container stop failed: ${err}`);
  }
}

export async function execInContainer(
  containerId: string,
  command: string,
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

  // Start exec
  const startRes = await dockerFetch(`/v1.44/exec/${Id}/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ Detach: false }),
    timeout: 600000,
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

export async function getContainerLogs(containerId: string, tail: number): Promise<string> {
  const params = new URLSearchParams({
    stdout: "true",
    stderr: "true",
    tail: String(tail),
  });
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
  return output;
}

export async function inspectContainer(containerId: string): Promise<{ running: boolean }> {
  const res = await dockerFetch(`/v1.44/containers/${containerId}/json`);
  if (!res.ok) return { running: false };
  const data = (await res.json()) as { State: { Running: boolean } };
  return { running: data.State.Running };
}
