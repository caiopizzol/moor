process.env.MOOR_DB_PATH = ":memory:";
process.env.HOSTNAME = "";

import { beforeEach, describe, expect, test } from "bun:test";
import type { ResolvedFile } from "./container-config";
import type { DockerFetch } from "./docker";

const {
  buildContainerCreateBody,
  buildImageStreaming,
  createAndStartContainer,
  pullImageStreaming,
} = await import("./docker");
const { classifyBuildError } = await import("./build-error-classifier");
const { default: db } = await import("./db");
const { createCredential } = await import("./registry-credentials-db");

type DockerCall = {
  path: string;
  method: string;
  headers?: HeadersInit;
  body?: BodyInit | null;
  timeout?: number;
};

function streamResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, { status });
}

function recordCall(calls: DockerCall[], path: string, opts?: RequestInit & { timeout?: number }) {
  calls.push({
    path,
    method: opts?.method ?? "GET",
    headers: opts?.headers,
    body: opts?.body,
    timeout: opts?.timeout,
  });
}

function parseJsonBody<T>(body: BodyInit | null | undefined): T {
  if (typeof body !== "string") {
    throw new Error("expected JSON string body");
  }
  return JSON.parse(body) as T;
}

function headerValue(headers: HeadersInit | undefined, name: string): string | null {
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get(name);
  const lower = name.toLowerCase();
  if (Array.isArray(headers)) {
    return headers.find(([key]) => key.toLowerCase() === lower)?.[1] ?? null;
  }
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === lower);
  return entry?.[1] ?? null;
}

function tarField(buf: Uint8Array, offset: number, len: number): string {
  let end = offset;
  while (end < offset + len && buf[end] !== 0) end++;
  return new TextDecoder().decode(buf.slice(offset, end));
}

function tarContent(buf: Uint8Array, len: number): string {
  return new TextDecoder().decode(buf.slice(512, 512 + len));
}

function dockerFetchForCreate(calls: DockerCall[], id: string): DockerFetch {
  return async (path, opts) => {
    recordCall(calls, path, opts);
    if (path.includes("/containers/create")) {
      return Response.json({ Id: id }, { status: 201 });
    }
    return new Response("", { status: path.endsWith("/start") ? 204 : 200 });
  };
}

beforeEach(() => {
  process.env.HOSTNAME = "";
  db.query("DELETE FROM registry_credentials").run();
});

describe("buildImageStreaming", () => {
  test("parses chunked JSON frames, omits progress frames, and sends build params", async () => {
    const calls: DockerCall[] = [];
    const imageId = "sha256:abcdef1234567890abcdef";
    const fetchImpl: DockerFetch = async (path, opts) => {
      recordCall(calls, path, opts);
      return streamResponse([
        '{"stream":"Step 1/2\\n"}\n{"status":"Downloading","id":"layer1","progress":"[=>]"}\n',
        `{"status":"Download complete","id":"layer1"}\n{"aux":{"ID":"${imageId}"}}\npla`,
        "in text\n",
      ]);
    };
    const lines: string[] = [];

    await buildImageStreaming(
      "https://github.com/acme/app",
      "main",
      "Dockerfile.prod",
      "moor/app:latest",
      (line) => lines.push(line),
      true,
      undefined,
      fetchImpl,
    );

    expect(lines).toEqual([
      "Step 1/2\n",
      "layer1: Download complete\n",
      `Built image: ${imageId.slice(0, 19)}\n`,
      "plain text\n",
    ]);
    expect(calls).toHaveLength(1);
    const url = new URL(`http://localhost${calls[0].path}`);
    expect(url.pathname).toBe("/v1.44/build");
    expect(url.searchParams.get("remote")).toBe("https://github.com/acme/app.git#main");
    expect(url.searchParams.get("dockerfile")).toBe("Dockerfile.prod");
    expect(url.searchParams.get("t")).toBe("moor/app:latest");
    expect(url.searchParams.get("nocache")).toBe("true");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].timeout).toBe(1_800_000);
  });

  test("redacts Docker error frames while preserving build-error classification", async () => {
    const fetchImpl: DockerFetch = async () =>
      streamResponse([
        `${JSON.stringify({
          error: [
            "fatal: could not read Username for",
            "'https://user:secret@github.com/acme/private': terminal prompts disabled",
          ].join(" "),
        })}\n`,
      ]);
    const lines: string[] = [];
    let thrown: unknown;

    try {
      await buildImageStreaming(
        "https://user:secret@github.com/acme/private",
        "main",
        "Dockerfile",
        "moor/private:latest",
        (line) => lines.push(line),
        false,
        undefined,
        fetchImpl,
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = thrown instanceof Error ? thrown.message : "";
    expect(message).toContain("terminal prompts disabled");
    expect(message).not.toContain("secret");
    expect(lines.join("")).not.toContain("secret");
    expect(classifyBuildError(message)).toBe("source_credential_required");
  });
});

describe("pullImageStreaming", () => {
  test("parses progress output and sends X-Registry-Auth from stored credentials", async () => {
    createCredential({ hostname: "ghcr.io", username: "alice", secret: "ghp_secret" });
    const calls: DockerCall[] = [];
    const fetchImpl: DockerFetch = async (path, opts) => {
      recordCall(calls, path, opts);
      if (path === "/v1.44/version") {
        return Response.json({ Os: "linux", Arch: "amd64" });
      }
      return streamResponse([
        '{"status":"Pulling from acme/app"}\n',
        '{"status":"Downloading","id":"layer1","progress":"[==>]"}\n',
        '{"status":"Download complete","id":"layer1"}\n',
      ]);
    };
    const lines: string[] = [];

    await pullImageStreaming(
      "ghcr.io/acme/app:1.2.3",
      (line) => lines.push(line),
      undefined,
      fetchImpl,
    );

    expect(lines).toEqual(["Pulling from acme/app\n", "layer1: Download complete\n"]);
    const createCall = calls.find((call) => call.path.startsWith("/v1.44/images/create?"));
    expect(createCall).toBeDefined();
    if (!createCall) throw new Error("missing image create call");
    const url = new URL(`http://localhost${createCall.path}`);
    expect(url.searchParams.get("fromImage")).toBe("ghcr.io/acme/app");
    expect(url.searchParams.get("tag")).toBe("1.2.3");
    expect(url.searchParams.get("platform")).toBe("linux/amd64");

    const authHeader = headerValue(createCall.headers, "X-Registry-Auth");
    expect(authHeader).toBeTruthy();
    if (!authHeader) throw new Error("missing X-Registry-Auth header");
    const decoded = JSON.parse(Buffer.from(authHeader, "base64url").toString("utf8")) as {
      username: string;
      password: string;
      serveraddress: string;
    };
    expect(decoded).toEqual({
      username: "alice",
      password: "ghp_secret",
      serveraddress: "ghcr.io",
    });
  });

  test("throws Docker pull error frames after emitting the parsed error line", async () => {
    const fetchImpl: DockerFetch = async (path) => {
      if (path === "/v1.44/version") return new Response("", { status: 404 });
      return streamResponse(['{"error":"manifest unknown"}\n']);
    };
    const lines: string[] = [];

    await expect(
      pullImageStreaming(
        "ghcr.io/acme/missing:latest",
        (line) => lines.push(line),
        undefined,
        fetchImpl,
      ),
    ).rejects.toThrow("ERROR: manifest unknown");
    expect(lines).toEqual(["ERROR: manifest unknown\n"]);
  });
});

describe("container create body and file injection", () => {
  test("builds env, ports, volumes, restart policy, labels, command, and entrypoint", () => {
    const body = buildContainerCreateBody({
      imageTag: "ghcr.io/acme/app:1.2.3",
      envVars: [
        { key: "NODE_ENV", value: "production" },
        { key: "TOKEN", value: "secret" },
      ],
      ports: [
        { host_port: 18080, container_port: 8080 },
        { host_port: 19090, container_port: 9090 },
      ],
      restartPolicy: "on-failure",
      limits: { memoryLimitMb: 256, cpus: 1.5 },
      volumes: [{ docker_name: "moor_data", target: "/data" }],
      labels: { "sh.moor.project_id": "42", "com.example.role": "api" },
      command: ["bun", "start"],
      entrypoint: ["/usr/bin/env"],
    });

    expect(body.Image).toBe("ghcr.io/acme/app:1.2.3");
    expect(body.Env).toEqual(["NODE_ENV=production", "TOKEN=secret"]);
    expect(body.ExposedPorts).toEqual({ "8080/tcp": {}, "9090/tcp": {} });
    expect(body.Labels).toEqual({ "sh.moor.project_id": "42", "com.example.role": "api" });
    expect(body.Cmd).toEqual(["bun", "start"]);
    expect(body.Entrypoint).toEqual(["/usr/bin/env"]);

    const hostConfig = body.HostConfig as Record<string, unknown>;
    expect(hostConfig.RestartPolicy).toEqual({ Name: "on-failure" });
    expect(hostConfig.PortBindings).toEqual({
      "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "18080" }],
      "9090/tcp": [{ HostIp: "127.0.0.1", HostPort: "19090" }],
    });
    expect(hostConfig.Mounts).toEqual([{ Type: "volume", Source: "moor_data", Target: "/data" }]);
    expect(hostConfig.Memory).toBe(268_435_456);
    expect(hostConfig.MemorySwap).toBe(268_435_456);
    expect(hostConfig.NanoCpus).toBe(1_500_000_000);
  });

  test("sends the create request body and injects declared files before start", async () => {
    const calls: DockerCall[] = [];
    const files: ResolvedFile[] = [
      { path: "/etc/moor/config.json", content: '{"ok":true}', mode: 0o600 },
    ];

    const id = await createAndStartContainer(
      "ghcr.io/acme/app:1.2.3",
      "moor-api",
      [{ key: "NODE_ENV", value: "production" }],
      [{ host_port: 18080, container_port: 8080 }],
      "unless-stopped",
      {},
      [{ docker_name: "moor_api_data", target: "/var/lib/app" }],
      { "sh.moor.project_name": "api" },
      { command: ["serve"], entrypoint: ["/entrypoint.sh"], files },
      dockerFetchForCreate(calls, "container-created"),
    );

    expect(id).toBe("container-created");
    const createIdx = calls.findIndex((call) => call.path.includes("/containers/create"));
    const archiveIdx = calls.findIndex((call) => call.path.includes("/archive"));
    const startIdx = calls.findIndex((call) => call.path.endsWith("/start"));
    expect(createIdx).toBeGreaterThanOrEqual(0);
    expect(archiveIdx).toBeGreaterThan(createIdx);
    expect(startIdx).toBeGreaterThan(archiveIdx);

    const createBody = parseJsonBody<Record<string, unknown>>(calls[createIdx].body);
    expect(createBody.Image).toBe("ghcr.io/acme/app:1.2.3");
    expect(createBody.Env).toEqual(["NODE_ENV=production"]);
    expect(createBody.Cmd).toEqual(["serve"]);
    expect(createBody.Entrypoint).toEqual(["/entrypoint.sh"]);
    expect(createBody.Labels).toEqual({ "sh.moor.project_name": "api" });

    const archiveCall = calls[archiveIdx];
    expect(headerValue(archiveCall.headers, "Content-Type")).toBe("application/x-tar");
    expect(archiveCall.body).toBeInstanceOf(Uint8Array);
    const tar = archiveCall.body as Uint8Array;
    expect(tarField(tar, 0, 100)).toBe("etc/moor/config.json");
    expect(Number.parseInt(tarField(tar, 100, 8), 8)).toBe(0o600);
    expect(tarContent(tar, '{"ok":true}'.length)).toBe('{"ok":true}');
  });
});

describe("compose network attach", () => {
  test("discovers the compose project and connects the new container before start", async () => {
    process.env.HOSTNAME = "moor-self";
    const calls: DockerCall[] = [];
    const fetchImpl: DockerFetch = async (path, opts) => {
      recordCall(calls, path, opts);
      if (path.includes("/containers/create")) {
        return Response.json({ Id: "container-net" }, { status: 201 });
      }
      if (path === "/v1.44/containers/moor-self/json") {
        return Response.json({
          Config: { Labels: { "com.docker.compose.project": "moorproj" } },
        });
      }
      if (path.startsWith("/v1.44/networks?")) {
        return Response.json([{ Name: "moorproj_default" }]);
      }
      if (path.endsWith("/connect")) {
        return new Response("endpoint with name moor-api already exists", { status: 403 });
      }
      return new Response("", { status: path.endsWith("/start") ? 204 : 200 });
    };

    const id = await createAndStartContainer(
      "alpine:latest",
      "moor-api",
      [],
      [],
      "unless-stopped",
      {},
      [],
      {},
      {},
      fetchImpl,
    );

    expect(id).toBe("container-net");
    const networksCall = calls.find((call) => call.path.startsWith("/v1.44/networks?"));
    expect(networksCall).toBeDefined();
    if (!networksCall) throw new Error("missing network list call");
    const filters = new URL(`http://localhost${networksCall.path}`).searchParams.get("filters");
    expect(filters ? JSON.parse(filters) : null).toEqual({
      label: ["com.docker.compose.project=moorproj", "com.docker.compose.network=default"],
    });

    const connectIdx = calls.findIndex((call) => call.path.endsWith("/connect"));
    const startIdx = calls.findIndex((call) => call.path.endsWith("/start"));
    expect(connectIdx).toBeGreaterThanOrEqual(0);
    expect(startIdx).toBeGreaterThan(connectIdx);
    expect(calls[connectIdx].path).toBe("/v1.44/networks/moorproj_default/connect");
    expect(parseJsonBody<{ Container: string }>(calls[connectIdx].body)).toEqual({
      Container: "container-net",
    });
  });

  test("network attach failure removes the created container and does not start it", async () => {
    process.env.HOSTNAME = "moor-self";
    const calls: DockerCall[] = [];
    const fetchImpl: DockerFetch = async (path, opts) => {
      recordCall(calls, path, opts);
      if (path.includes("/containers/create")) {
        return Response.json({ Id: "container-net-fail" }, { status: 201 });
      }
      if (path === "/v1.44/containers/moor-self/json") {
        return Response.json({
          Config: { Labels: { "com.docker.compose.project": "moorproj" } },
        });
      }
      if (path.startsWith("/v1.44/networks?")) {
        return Response.json([{ Name: "moorproj_default" }]);
      }
      if (path.endsWith("/connect")) {
        return new Response("bridge unavailable", { status: 500 });
      }
      return new Response("", { status: 204 });
    };

    await expect(
      createAndStartContainer(
        "alpine:latest",
        "moor-api",
        [],
        [],
        "unless-stopped",
        {},
        [],
        {},
        {},
        fetchImpl,
      ),
    ).rejects.toThrow("Network connect failed (500): bridge unavailable");

    expect(calls.some((call) => call.path.endsWith("/start"))).toBe(false);
    expect(
      calls.some((call) => call.path === "/v1.44/containers/container-net-fail?force=true"),
    ).toBe(true);
  });
});

describe("start cleanup and status handling", () => {
  test("start status 304 is accepted and does not remove the created container", async () => {
    const calls: DockerCall[] = [];
    const fetchImpl: DockerFetch = async (path, opts) => {
      recordCall(calls, path, opts);
      if (path.includes("/containers/create")) {
        return Response.json({ Id: "container-304" }, { status: 201 });
      }
      if (path.endsWith("/start")) return new Response("", { status: 304 });
      return new Response("", { status: 404 });
    };

    const id = await createAndStartContainer(
      "alpine:latest",
      "moor-api",
      [],
      [],
      "unless-stopped",
      {},
      [],
      {},
      {},
      fetchImpl,
    );

    expect(id).toBe("container-304");
    expect(calls.some((call) => call.path === "/v1.44/containers/container-304?force=true")).toBe(
      false,
    );
  });

  test("failed start removes the created container and rethrows the start error", async () => {
    const calls: DockerCall[] = [];
    const fetchImpl: DockerFetch = async (path, opts) => {
      recordCall(calls, path, opts);
      if (path.includes("/containers/create")) {
        return Response.json({ Id: "container-failed" }, { status: 201 });
      }
      if (path.endsWith("/start")) return new Response("boom", { status: 500 });
      return new Response("", { status: 204 });
    };

    await expect(
      createAndStartContainer(
        "alpine:latest",
        "moor-api",
        [],
        [],
        "unless-stopped",
        {},
        [],
        {},
        {},
        fetchImpl,
      ),
    ).rejects.toThrow("Container start failed: boom");

    const startIdx = calls.findIndex((call) => call.path.endsWith("/start"));
    const cleanupIdx = calls.findIndex(
      (call) => call.path === "/v1.44/containers/container-failed?force=true",
    );
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(cleanupIdx).toBeGreaterThan(startIdx);
  });
});
