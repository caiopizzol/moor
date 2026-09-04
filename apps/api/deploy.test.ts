process.env.MOOR_DB_PATH = ":memory:";

import { describe, expect, test } from "bun:test";
import type { BuildRunLike, DeployDeps, Project, ProjectActionResult } from "./deploy";

const {
  buildProject,
  deployProject,
  restartProject,
  startProject,
  stopProject,
  withProjectLifecycleLock,
} = await import("./deploy");

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
    getProjectLifecycleState: (project) => ({
      image_tag: project.image_tag,
      container_id: project.container_id,
    }),
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
      "drain",
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
      "drain",
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

describe("restartProject orchestration", () => {
  test("rejects drain before stopping the container", async () => {
    const ops: string[] = [];
    const deps = makeDeps(ops, {
      requireNotDraining: () => {
        ops.push("drain");
        return Response.json({ error: "moor is draining" }, { status: 503 });
      },
    });

    const result = await restartProject(
      makeProject({ image_tag: "moor/app:latest", container_id: "container-old" }),
      deps,
    );

    expect(result.kind).toBe("response");
    if (result.kind !== "response") return;
    expect(result.response.status).toBe(503);
    expect(ops).toEqual(["drain"]);
  });

  test("stops before starting and returns a restart result", async () => {
    const ops: string[] = [];

    const result = await restartProject(
      makeProject({ image_tag: "moor/app:latest", container_id: "container-old" }),
      makeDeps(ops),
    );

    expect(result).toEqual({ kind: "json", body: { message: "Container restarted" } });
    expect(ops).toEqual([
      "drain",
      "stop:container-old",
      "status:stopped:container-old",
      "envs:1",
      "ports:1",
      "volumes:1",
      "files:1:1",
      "create:moor/app:latest:moor-app:envs=1:ports=1:restart=unless-stopped:mem=null:cpus=null:volumes=1:cmd=0:entrypoint=0:files=0",
      "container:1:container-1",
      "status:running:container-1",
    ]);
  });

  test("starts a stopped project that has no existing container", async () => {
    const ops: string[] = [];

    const result = await restartProject(
      makeProject({ image_tag: "moor/app:latest", container_id: null, status: "stopped" }),
      makeDeps(ops),
    );

    expect(result).toEqual({ kind: "json", body: { message: "Container restarted" } });
    expect(ops).toEqual([
      "drain",
      "status:stopped:null",
      "envs:1",
      "ports:1",
      "volumes:1",
      "files:1:1",
      "create:moor/app:latest:moor-app:envs=1:ports=1:restart=unless-stopped:mem=null:cpus=null:volumes=1:cmd=0:entrypoint=0:files=0",
      "container:1:container-1",
      "status:running:container-1",
    ]);
  });

  test("returns the start failure after stopping", async () => {
    const ops: string[] = [];
    const deps = makeDeps(ops, {
      createAndStartContainer: async () => {
        ops.push("create:throw");
        throw new Error("container failed");
      },
    });

    const result = await restartProject(
      makeProject({ image_tag: "moor/app:latest", container_id: "container-old" }),
      deps,
    );

    await expectErrorResult(result, 500, "container failed");
    expect(ops).toEqual([
      "drain",
      "stop:container-old",
      "status:stopped:container-old",
      "envs:1",
      "ports:1",
      "volumes:1",
      "files:1:1",
      "create:throw",
      "status:error:container-old",
    ]);
  });

  test("rejects a missing image before stopping", async () => {
    const ops: string[] = [];

    const result = await restartProject(
      makeProject({ image_tag: null, container_id: "container-old" }),
      makeDeps(ops),
    );

    await expectErrorResult(result, 400, "No image built yet");
    expect(ops).toEqual(["drain"]);
  });
});

describe("project lifecycle serialization", () => {
  test("rejects a deploy when drain starts while it waits for the lifecycle lock", async () => {
    const ops: string[] = [];
    let draining = false;
    let markLockHeld: () => void = () => {};
    let releaseLock: () => void = () => {};
    const lockHeld = new Promise<void>((resolve) => {
      markLockHeld = resolve;
    });
    const lockGate = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const project = makeProject();
    const activeLifecycle = withProjectLifecycleLock(project.id, async () => {
      markLockHeld();
      await lockGate;
    });
    await lockHeld;
    const deps = makeDeps(ops, {
      requireNotDraining: () => {
        ops.push("drain");
        return draining ? Response.json({ error: "moor is draining" }, { status: 503 }) : null;
      },
    });

    const deployed = await deployProject(project, { noCache: false }, deps);
    expect(deployed.kind).toBe("stream");
    if (deployed.kind !== "stream") return;
    draining = true;
    releaseLock();
    await activeLifecycle;
    const sse = await readStream(deployed.stream);

    expect(ops).toEqual(["drain", "resolve:https://github.com/owner/repo:none", "drain"]);
    expect(sse).toContain('event: error\ndata: "moor is draining"');
  });

  test("serializes overlapping restarts for the same project", async () => {
    const ops: string[] = [];
    let stopCalls = 0;
    let currentContainerId: string | null = "container-old";
    let markFirstStopStarted: () => void = () => {};
    let releaseFirstStop: () => void = () => {};
    const firstStopStarted = new Promise<void>((resolve) => {
      markFirstStopStarted = resolve;
    });
    const firstStopGate = new Promise<void>((resolve) => {
      releaseFirstStop = resolve;
    });
    const deps = makeDeps(ops, {
      stopContainer: async (containerId) => {
        stopCalls += 1;
        ops.push(`stop:${containerId}:${stopCalls}`);
        if (stopCalls === 1) {
          markFirstStopStarted();
          await firstStopGate;
        }
      },
      getProjectLifecycleState: () => ({
        image_tag: "moor/app:latest",
        container_id: currentContainerId,
      }),
      updateProjectContainerId: (_projectId, containerId) => {
        currentContainerId = containerId;
      },
    });
    const project = makeProject({
      image_tag: "moor/app:latest",
      container_id: "container-old",
    });

    const first = restartProject(project, deps);
    await firstStopStarted;
    const second = restartProject(project, deps);
    await Promise.resolve();
    const callsBeforeRelease = stopCalls;
    releaseFirstStop();
    await Promise.all([first, second]);

    expect(callsBeforeRelease).toBe(1);
    expect(stopCalls).toBe(2);
    expect(ops.filter((op) => op.startsWith("stop:"))).toEqual([
      "stop:container-old:1",
      "stop:container-1:2",
    ]);
  });

  test("serializes deploy container replacement against start", async () => {
    const ops: string[] = [];
    let createCalls = 0;
    let markFirstCreateStarted: () => void = () => {};
    let releaseFirstCreate: () => void = () => {};
    const firstCreateStarted = new Promise<void>((resolve) => {
      markFirstCreateStarted = resolve;
    });
    const firstCreateGate = new Promise<void>((resolve) => {
      releaseFirstCreate = resolve;
    });
    const deps = makeDeps(ops, {
      createAndStartContainer: async () => {
        createCalls += 1;
        if (createCalls === 1) {
          markFirstCreateStarted();
          await firstCreateGate;
        }
        return `container-${createCalls}`;
      },
    });
    const project = makeProject({ image_tag: "moor/app:latest" });

    const deployed = await deployProject(project, { noCache: false }, deps);
    expect(deployed.kind).toBe("stream");
    if (deployed.kind !== "stream") return;
    await firstCreateStarted;
    const started = startProject(project, deps);
    await Promise.resolve();
    const callsBeforeRelease = createCalls;
    releaseFirstCreate();
    await Promise.all([readStream(deployed.stream), started]);

    expect(callsBeforeRelease).toBe(1);
    expect(createCalls).toBe(2);
  });

  test("a stop queued behind restart uses the new container id", async () => {
    const ops: string[] = [];
    let currentContainerId: string | null = "container-old";
    let markCreateStarted: () => void = () => {};
    let releaseCreate: () => void = () => {};
    const createStarted = new Promise<void>((resolve) => {
      markCreateStarted = resolve;
    });
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const deps = makeDeps(ops, {
      createAndStartContainer: async () => {
        markCreateStarted();
        await createGate;
        return "container-new";
      },
      getProjectLifecycleState: () => ({
        image_tag: "moor/app:latest",
        container_id: currentContainerId,
      }),
      updateProjectContainerId: (_projectId, containerId) => {
        currentContainerId = containerId;
        ops.push(`container:1:${containerId}`);
      },
    });
    const project = makeProject({
      image_tag: "moor/app:latest",
      container_id: "container-old",
    });

    const restarted = restartProject(project, deps);
    await createStarted;
    const stopped = stopProject(project, deps);
    await Promise.resolve();
    releaseCreate();
    await Promise.all([restarted, stopped]);

    expect(ops.filter((op) => op.startsWith("stop:"))).toEqual([
      "stop:container-old",
      "stop:container-new",
    ]);
    expect(currentContainerId).toBe("container-new");
    expect(ops.at(-1)).toBe("status:stopped:container-new");
  });

  test("a start queued behind deploy uses the new image tag", async () => {
    const ops: string[] = [];
    const createdFrom: string[] = [];
    let currentImageTag: string | null = "moor/app:old";
    let currentContainerId: string | null = "container-old";
    let markDeployCreateStarted: () => void = () => {};
    let releaseDeployCreate: () => void = () => {};
    const deployCreateStarted = new Promise<void>((resolve) => {
      markDeployCreateStarted = resolve;
    });
    const deployCreateGate = new Promise<void>((resolve) => {
      releaseDeployCreate = resolve;
    });
    const deps = makeDeps(ops, {
      createAndStartContainer: async (imageTag) => {
        createdFrom.push(imageTag);
        if (createdFrom.length === 1) {
          markDeployCreateStarted();
          await deployCreateGate;
        }
        return `container-${createdFrom.length}`;
      },
      getProjectLifecycleState: () => ({
        image_tag: currentImageTag,
        container_id: currentContainerId,
      }),
      updateProjectImageTag: (_projectId, imageTag) => {
        currentImageTag = imageTag;
      },
      updateProjectContainerId: (_projectId, containerId) => {
        currentContainerId = containerId;
      },
    });
    const project = makeProject({
      image_tag: "moor/app:old",
      container_id: "container-old",
    });

    const deployed = await deployProject(project, { noCache: false }, deps);
    expect(deployed.kind).toBe("stream");
    if (deployed.kind !== "stream") return;
    await deployCreateStarted;
    const started = startProject(project, deps);
    releaseDeployCreate();
    await Promise.all([readStream(deployed.stream), started]);

    expect(createdFrom).toEqual(["moor/app:latest", "moor/app:latest"]);
  });

  test("does not serialize lifecycle work for different projects", async () => {
    const ops: string[] = [];
    let markFirstCreateStarted: () => void = () => {};
    let markSecondProjectStarted: () => void = () => {};
    let releaseFirstCreate: () => void = () => {};
    const firstCreateStarted = new Promise<void>((resolve) => {
      markFirstCreateStarted = resolve;
    });
    const secondProjectStarted = new Promise<void>((resolve) => {
      markSecondProjectStarted = resolve;
    });
    const firstCreateGate = new Promise<void>((resolve) => {
      releaseFirstCreate = resolve;
    });
    const deps = makeDeps(ops, {
      createAndStartContainer: async (_imageTag, name) => {
        if (name === "moor-app") {
          markFirstCreateStarted();
          await firstCreateGate;
          return "container-app";
        }
        markSecondProjectStarted();
        return "container-other";
      },
    });

    const first = startProject(makeProject({ image_tag: "moor/app:latest" }), deps);
    await firstCreateStarted;
    const second = startProject(
      makeProject({ id: 2, name: "other", image_tag: "moor/other:latest" }),
      deps,
    );
    const secondStartedBeforeRelease = await Promise.race([
      secondProjectStarted.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    releaseFirstCreate();
    await Promise.all([first, second]);

    expect(secondStartedBeforeRelease).toBe(true);
  });

  test("does not recreate a project deleted while its start was queued", async () => {
    const ops: string[] = [];
    let createCalls = 0;
    let projectExists = true;
    let markFirstCreateStarted: () => void = () => {};
    let releaseFirstCreate: () => void = () => {};
    const firstCreateStarted = new Promise<void>((resolve) => {
      markFirstCreateStarted = resolve;
    });
    const firstCreateGate = new Promise<void>((resolve) => {
      releaseFirstCreate = resolve;
    });
    const deps = makeDeps(ops, {
      createAndStartContainer: async () => {
        createCalls += 1;
        if (createCalls === 1) {
          markFirstCreateStarted();
          await firstCreateGate;
        }
        return `container-${createCalls}`;
      },
      getProjectLifecycleState: () =>
        projectExists ? { image_tag: "moor/app:latest", container_id: "container-old" } : null,
    });
    const project = makeProject({
      image_tag: "moor/app:latest",
      container_id: "container-old",
    });

    const first = startProject(project, deps);
    await firstCreateStarted;
    const queued = startProject(project, deps);
    projectExists = false;
    releaseFirstCreate();
    await first;
    const result = await queued;

    expect(createCalls).toBe(1);
    await expectErrorResult(result, 404, "Not found");
  });

  test("a stop requested during deploy runs after the full deploy lifecycle", async () => {
    const ops: string[] = [];
    let currentContainerId: string | null = "container-old";
    let stopCalls = 0;
    let markBuildStarted: () => void = () => {};
    let releaseBuild: () => void = () => {};
    const buildStarted = new Promise<void>((resolve) => {
      markBuildStarted = resolve;
    });
    const buildGate = new Promise<void>((resolve) => {
      releaseBuild = resolve;
    });
    const deps = makeDeps(ops, {
      buildImageStreaming: async () => {
        markBuildStarted();
        await buildGate;
      },
      createAndStartContainer: async () => {
        ops.push("create:container-new");
        return "container-new";
      },
      stopContainer: async (containerId) => {
        stopCalls += 1;
        ops.push(`stop:${containerId}`);
      },
      getProjectLifecycleState: () => ({
        image_tag: "moor/app:latest",
        container_id: currentContainerId,
      }),
      updateProjectContainerId: (_projectId, containerId) => {
        currentContainerId = containerId;
      },
    });
    const project = makeProject({
      image_tag: "moor/app:old",
      container_id: "container-old",
    });

    const deployed = await deployProject(project, { noCache: false }, deps);
    expect(deployed.kind).toBe("stream");
    if (deployed.kind !== "stream") return;
    await buildStarted;
    const stopped = stopProject(project, deps);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const stopCallsBeforeBuildRelease = stopCalls;
    releaseBuild();
    await Promise.all([readStream(deployed.stream), stopped]);

    expect(stopCallsBeforeBuildRelease).toBe(0);
    expect(ops.indexOf("create:container-new")).toBeLessThan(ops.indexOf("stop:container-new"));
    expect(ops.at(-1)).toBe("status:stopped:container-new");
  });
});
