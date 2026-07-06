process.env.MOOR_DB_PATH = ":memory:";

import { describe, expect, test } from "bun:test";
import type { BuildRunLike, DeployDeps, Project, ProjectActionResult } from "./deploy";

const { buildProject, deployProject, startProject } = await import("./deploy");

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 1,
    name: "app",
    github_url: "https://github.com/owner/repo",
    docker_image: null,
    branch: "main",
    dockerfile: "Dockerfile",
    image_tag: null,
    container_id: null,
    status: "stopped",
    domain: null,
    domain_port: null,
    restart_policy: "unless-stopped",
    memory_limit_mb: null,
    cpus: null,
    source_credential_id: null,
    command: null,
    entrypoint: null,
    ...overrides,
  };
}

function makeRun(ops: string[]): BuildRunLike {
  return {
    abort: new AbortController(),
    appendStdout: (text) => ops.push(`stdout:${text}`),
    appendStderr: (text) => ops.push(`stderr:${text}`),
    markStreamingDone: () => ops.push("run:streamingDone"),
    finalize: (exitCode) => ops.push(`run:finalize:${exitCode}`),
  };
}

function makeDeps(ops: string[], overrides: Partial<DeployDeps> = {}): DeployDeps {
  let now = 1_000;
  const base: DeployDeps = {
    requireNotDraining: () => {
      ops.push("drain");
      return null;
    },
    resolveCredentialForBuild: (githubUrl, sourceCredentialId) => {
      ops.push(`resolve:${githubUrl}:${sourceCredentialId ?? "none"}`);
      return {
        ok: true,
        value: {
          cloneUrl: "https://github.com/owner/repo.git",
          used_credential_id: sourceCredentialId ?? null,
        },
      };
    },
    setProjectRecordedStatus: (_projectId, status, containerId) => {
      ops.push(`status:${status}:${containerId ?? "null"}`);
    },
    reconcileProjectStatusAfterInterrupt: async (_projectId, containerId) => {
      ops.push(`reconcile:${containerId ?? "null"}`);
      return "stopped";
    },
    createBuildRun: (projectId) => {
      ops.push(`run:create:${projectId}`);
      return makeRun(ops);
    },
    buildImageStreaming: async (cloneUrl, branch, dockerfile, tag, onLine, noCache, signal) => {
      ops.push(
        `build:${cloneUrl}:${branch}:${dockerfile}:${tag}:nocache=${noCache}:aborted=${signal?.aborted ?? false}`,
      );
      onLine("build line\n");
    },
    pullImageStreaming: async (imageRef, onLine, signal) => {
      ops.push(`pull:${imageRef}:aborted=${signal?.aborted ?? false}`);
      onLine("pull line\n");
    },
    autoDetectPorts: async (projectId, imageTag, force) => {
      ops.push(`detectPorts:${projectId}:${imageTag}:${force === true}`);
      return [{ host_port: 18080, container_port: 8080 }];
    },
    listEnvVars: (projectId) => {
      ops.push(`envs:${projectId}`);
      return [{ key: "NODE_ENV", value: "production" }];
    },
    getProjectPorts: (projectId) => {
      ops.push(`ports:${projectId}`);
      return [{ host_port: 18080, container_port: 8080 }];
    },
    getProjectVolumes: (projectId) => {
      ops.push(`volumes:${projectId}`);
      return [{ docker_name: "app-data", target: "/data" }];
    },
    getResolvedProjectFiles: (projectId, envs) => {
      ops.push(`files:${projectId}:${envs.length}`);
      return [];
    },
    createAndStartContainer: async (
      imageTag,
      name,
      envs,
      ports = [],
      restartPolicy = "unless-stopped",
      limits = {},
      volumes = [],
      _labels = {},
      extras = {},
    ) => {
      ops.push(
        `create:${imageTag}:${name}:envs=${envs.length}:ports=${ports.length}:restart=${restartPolicy}:mem=${limits.memoryLimitMb ?? "null"}:cpus=${limits.cpus ?? "null"}:volumes=${volumes.length}:cmd=${extras.command?.length ?? 0}:entrypoint=${extras.entrypoint?.length ?? 0}:files=${extras.files?.length ?? 0}`,
      );
      return "container-1";
    },
    stopContainer: async (containerId) => {
      ops.push(`stop:${containerId}`);
    },
    syncCaddyRoutes: async () => {
      ops.push("caddy");
    },
    updateProjectImageTag: (projectId, imageTag) => {
      ops.push(`image:${projectId}:${imageTag}`);
    },
    updateProjectContainerId: (projectId, containerId) => {
      ops.push(`container:${projectId}:${containerId}`);
    },
    now: () => {
      const current = now;
      now += 1_500;
      return current;
    },
  };

  return { ...base, ...overrides };
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }

  text += decoder.decode();
  return text;
}

async function expectErrorResult(
  result: ProjectActionResult,
  status: number,
  error: string,
): Promise<void> {
  expect(result.kind).toBe("response");
  if (result.kind !== "response") return;
  expect(result.response.status).toBe(status);
  expect(result.response.headers.get("content-type") || "").toContain("application/json");
  expect(await result.response.json()).toEqual({ error });
}

describe("deployProject orchestration", () => {
  test("builds, records, detects ports, starts container, syncs routes, and finalizes success", async () => {
    const ops: string[] = [];
    const project = makeProject({ domain: "app.example.com", domain_port: 8080 });
    const result = await deployProject(project, { noCache: true }, makeDeps(ops));

    expect(result.kind).toBe("stream");
    if (result.kind !== "stream") return;
    const sse = await readStream(result.stream);

    expect(ops).toEqual([
      "drain",
      "resolve:https://github.com/owner/repo:none",
      "status:building:null",
      "run:create:1",
      "build:https://github.com/owner/repo.git:main:Dockerfile:moor/app:latest:nocache=true:aborted=false",
      "stdout:build line\n",
      "run:streamingDone",
      "image:1:moor/app:latest",
      "status:stopped:null",
      "stdout:\nBuild completed in 1.5s\n",
      "detectPorts:1:moor/app:latest:true",
      "stdout:Port 8080 → host :18080\n",
      "stdout:Starting container...\n",
      "envs:1",
      "ports:1",
      "volumes:1",
      "files:1:1",
      "create:moor/app:latest:moor-app:envs=1:ports=1:restart=unless-stopped:mem=null:cpus=null:volumes=1:cmd=0:entrypoint=0:files=0",
      "container:1:container-1",
      "status:running:container-1",
      "caddy",
      "stdout:Route: app.example.com -> :8080\n",
      "run:finalize:0",
    ]);
    expect(sse).toContain('event: log\ndata: "build line\\n"');
    expect(sse).toContain('event: log\ndata: "Starting container...\\n"');
    expect(sse).toContain('event: done\ndata: "Container started"');
  });

  test("finalizes build failure without image update or container start", async () => {
    const ops: string[] = [];
    const deps = makeDeps(ops, {
      buildImageStreaming: async () => {
        ops.push("build:throw");
        throw new Error("Docker build failed");
      },
    });
    const result = await deployProject(makeProject(), { noCache: false }, deps);

    expect(result.kind).toBe("stream");
    if (result.kind !== "stream") return;
    const sse = await readStream(result.stream);

    expect(ops).toEqual([
      "drain",
      "resolve:https://github.com/owner/repo:none",
      "status:building:null",
      "run:create:1",
      "build:throw",
      "stderr:Docker build failed\n",
      "run:finalize:1",
      "status:error:null",
    ]);
    expect(sse).toContain('event: error\ndata: "Docker build failed"');
    expect(ops.some((op) => op.startsWith("image:"))).toBe(false);
    expect(ops.some((op) => op.startsWith("create:"))).toBe(false);
  });

  test("drain rejection returns before resolving credentials or creating a run", async () => {
    const ops: string[] = [];
    const deps = makeDeps(ops, {
      requireNotDraining: () => {
        ops.push("drain");
        return Response.json({ error: "moor is draining" }, { status: 503 });
      },
    });
    const result = await deployProject(makeProject(), { noCache: false }, deps);

    expect(result.kind).toBe("response");
    if (result.kind !== "response") return;
    expect(result.response.status).toBe(503);
    expect(await result.response.json()).toEqual({ error: "moor is draining" });
    expect(ops).toEqual(["drain"]);
  });

  test("no source configured returns a JSON error response", async () => {
    const ops: string[] = [];
    const result = await deployProject(
      makeProject({ github_url: null, docker_image: null, image_tag: null }),
      { noCache: false },
      makeDeps(ops),
    );

    await expectErrorResult(result, 400, "No GitHub URL or Docker image configured");
    expect(ops).toEqual(["drain"]);
  });

  test("strict GitHub URL validation rejects unsupported hosts before side effects", async () => {
    const ops: string[] = [];
    const result = await deployProject(
      makeProject({ github_url: "https://gist.github.com/owner/repo" }),
      { noCache: false },
      makeDeps(ops),
    );

    await expectErrorResult(result, 400, "Only GitHub URLs are supported");
    expect(ops).toEqual(["drain"]);
  });

  test("build validation errors use the JSON error envelope", async () => {
    const ops: string[] = [];
    const result = await buildProject(makeProject({ github_url: null }), makeDeps(ops));

    await expectErrorResult(result, 400, "No GitHub URL configured");
    expect(ops).toEqual(["drain"]);
  });

  test("start validation errors use the JSON error envelope", async () => {
    const ops: string[] = [];
    const result = await startProject(makeProject({ image_tag: null }), makeDeps(ops));

    await expectErrorResult(result, 400, "No image built yet");
    expect(ops).toEqual(["drain"]);
  });

  test("container start failures use the JSON error envelope", async () => {
    const ops: string[] = [];
    const deps = makeDeps(ops, {
      createAndStartContainer: async () => {
        ops.push("create:throw");
        throw new Error("container failed");
      },
    });
    const result = await startProject(makeProject({ image_tag: "moor/app:latest" }), deps);

    await expectErrorResult(result, 500, "container failed");
    expect(ops).toEqual([
      "drain",
      "envs:1",
      "ports:1",
      "volumes:1",
      "files:1:1",
      "create:throw",
      "status:error:null",
    ]);
  });
});
