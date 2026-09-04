import { afterEach, describe, expect, test } from "bun:test";
import type { Project } from "../../contract/src/index";
import { apiGet, apiPost, apiPut, findProject, readErrorMessage, resolveProject } from "./client";

const originalFetch = globalThis.fetch;
const originalMoorUrl = process.env.MOOR_URL;
const originalMoorApiKey = process.env.MOOR_API_KEY;

type FetchCall = {
  input: Parameters<typeof fetch>[0];
  init: Parameters<typeof fetch>[1];
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv("MOOR_URL", originalMoorUrl);
  restoreEnv("MOOR_API_KEY", originalMoorApiKey);
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function configureClientEnv(): void {
  process.env.MOOR_URL = "https://moor.test/";
  process.env.MOOR_API_KEY = "test-key";
}

function captureFetch(response: Response): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (...args: Parameters<typeof fetch>): Promise<Response> => {
    const [input, init] = args;
    calls.push({ input, init });
    return response;
  }) as typeof fetch;
  return calls;
}

function firstCall(calls: FetchCall[]): FetchCall {
  const call = calls[0];
  if (!call) throw new Error("expected fetch to be called");
  return call;
}

describe("client API helpers", () => {
  test("findProject prefers exact names before normalized numeric IDs", () => {
    const projects = [
      { id: 7, name: "api" },
      { id: 8, name: "007" },
    ] as Project[];

    expect(findProject(projects, "007")?.id).toBe(8);
    expect(findProject(projects, "0007")?.id).toBe(7);
    expect(findProject(projects, "missing")).toBeUndefined();
  });

  test("apiGet returns the raw response while using the shared contract client", async () => {
    configureClientEnv();
    const rawResponse = new Response("not-json", { status: 418 });
    const calls = captureFetch(rawResponse);

    const res = await apiGet("/api/projects");

    expect(res).toBe(rawResponse);
    const call = firstCall(calls);
    expect(call.input).toBe("https://moor.test/api/projects");
    expect(call.init?.method).toBe("GET");
    const headers = new Headers(call.init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer test-key");
    expect(headers.get("Accept")).toBe("application/json");
  });

  test("apiPost and apiPut preserve raw responses and JSON request bodies", async () => {
    configureClientEnv();
    const calls = captureFetch(new Response("{}", { status: 200 }));

    await apiPost("/api/projects/1/run", { no_cache: true });
    await apiPut("/api/projects/1/envs", [{ key: "A", value: "B" }]);

    const post = firstCall(calls);
    expect(post.init?.method).toBe("POST");
    expect(post.init?.body).toBe(JSON.stringify({ no_cache: true }));
    expect(new Headers(post.init?.headers).get("Content-Type")).toBe("application/json");

    const put = calls[1];
    if (!put) throw new Error("expected second fetch call");
    expect(put.init?.method).toBe("PUT");
    expect(put.init?.body).toBe(JSON.stringify([{ key: "A", value: "B" }]));
    expect(new Headers(put.init?.headers).get("Content-Type")).toBe("application/json");
  });

  test("resolveProject uses the shared Project type without changing CLI errors", async () => {
    configureClientEnv();
    captureFetch(
      new Response(
        JSON.stringify([
          {
            id: 7,
            name: "api",
            status: "running",
            github_url: null,
            docker_image: "ghcr.io/example/api",
          },
        ]),
        { status: 200 },
      ),
    );

    const project = await resolveProject("7");

    expect(project.name).toBe("api");
    expect(project.docker_image).toBe("ghcr.io/example/api");
  });

  test("readErrorMessage keeps existing response parsing behavior", async () => {
    await expect(readErrorMessage(new Response("", { status: 503 }))).resolves.toBe("HTTP 503");
    await expect(
      readErrorMessage(new Response('{"error":"bad key"}', { status: 401 })),
    ).resolves.toBe("bad key");
  });
});
