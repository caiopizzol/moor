import { describe, expect, test } from "bun:test";
import { createMoorApiClient, type FetchLike, type MoorApiError } from "./client";

describe("createMoorApiClient", () => {
  test("sends bearer auth and JSON headers", async () => {
    const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
    const mockFetch: FetchLike = async (input, init) => {
      calls.push({ input, init });
      return Response.json({ ok: true });
    };
    const client = createMoorApiClient({
      baseUrl: "https://moor.example/",
      apiKey: "secret",
      fetch: mockFetch,
    });

    const result = await client.post<{ ok: true }>("/api/projects", { name: "app" });

    expect(result).toEqual({ ok: true });
    expect(calls[0].input).toBe("https://moor.example/api/projects");
    expect(calls[0].init?.method).toBe("POST");
    expect(calls[0].init?.body).toBe(JSON.stringify({ name: "app" }));
    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer secret");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("Accept")).toBe("application/json");
  });

  test("returns undefined for 204 responses", async () => {
    const client = createMoorApiClient({
      baseUrl: "https://moor.example",
      apiKey: "secret",
      fetch: async () => new Response(null, { status: 204 }),
    });

    await expect(client.delete<void>("/api/projects/1")).resolves.toBeUndefined();
  });

  test("turns JSON error bodies into MoorApiError", async () => {
    const client = createMoorApiClient({
      baseUrl: "https://moor.example",
      apiKey: "secret",
      fetch: async () => Response.json({ error: "bad api key" }, { status: 401 }),
    });

    await expect(client.get("/api/projects")).rejects.toMatchObject({
      name: "MoorApiError",
      status: 401,
      message: "bad api key",
      body: JSON.stringify({ error: "bad api key" }),
    } satisfies Partial<MoorApiError>);
  });

  test("falls back to text error bodies", async () => {
    const client = createMoorApiClient({
      baseUrl: "https://moor.example",
      apiKey: "secret",
      fetch: async () => new Response("Project not found", { status: 404 }),
    });

    await expect(client.get("/api/projects/99")).rejects.toMatchObject({
      status: 404,
      message: "Project not found",
    } satisfies Partial<MoorApiError>);
  });
});
