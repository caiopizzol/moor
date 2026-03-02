const SOCKET = "/var/run/docker.sock";

async function dockerFetch(
  path: string,
  opts?: RequestInit & { timeout?: number },
): Promise<Response> {
  const { timeout = 30000, ...init } = opts ?? {};
  return fetch(`http://localhost${path}`, {
    ...init,
    unix: SOCKET,
    signal: AbortSignal.timeout(timeout),
  });
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
  const res = await dockerFetch(`/v1.44/build?${params}`, {
    method: "POST",
    timeout: 300000,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Docker build failed: ${res.status} ${body}`);
  }

  // Stream the build output
  let output = "";
  const reader = res.body?.getReader();
  if (reader) {
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      output += decoder.decode(value, { stream: true });
    }
  }

  // Check for errors in the stream
  if (output.includes('"error"')) {
    const lines = output.split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.error) throw new Error(parsed.error);
      } catch {}
    }
  }

  return output;
}

export async function createAndStartContainer(
  imageTag: string,
  name: string,
  envVars: { key: string; value: string }[],
): Promise<string> {
  // Remove existing container with this name if it exists
  try {
    await dockerFetch(`/v1.44/containers/${name}?force=true`, { method: "DELETE" });
  } catch {}

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

export async function inspectContainer(containerId: string): Promise<{ running: boolean }> {
  const res = await dockerFetch(`/v1.44/containers/${containerId}/json`);
  if (!res.ok) return { running: false };
  const data = (await res.json()) as { State: { Running: boolean } };
  return { running: data.State.Running };
}
