import { afterEach, describe, expect, test } from "bun:test";
import { api } from "./src/lib/api";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("web projects API client", () => {
  test("delegates restart orchestration to one API request", async () => {
    const calls: Array<{ method: string; path: string }> = [];

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input : input.url,
        "http://localhost",
      );
      calls.push({ method: init?.method ?? "GET", path: url.pathname });
      return Response.json({ message: "Container restarted" });
    }) as typeof fetch;

    await api.projects.restart(7);

    expect(calls).toEqual([{ method: "POST", path: "/api/projects/7/restart" }]);
  });
});
