import { afterEach, describe, expect, test } from "bun:test";
import { envCommand } from "./env";

const originalFetch = globalThis.fetch;
const originalLog = console.log;
const originalMoorUrl = process.env.MOOR_URL;
const originalMoorApiKey = process.env.MOOR_API_KEY;

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.log = originalLog;
  restoreEnv("MOOR_URL", originalMoorUrl);
  restoreEnv("MOOR_API_KEY", originalMoorApiKey);
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("env set command", () => {
  test("delegates the running-project restart to one API request", async () => {
    process.env.MOOR_URL = "https://moor.test";
    process.env.MOOR_API_KEY = "test-key";
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];

    console.log = () => {};
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push(
        body === undefined ? { method, path: url.pathname } : { method, path: url.pathname, body },
      );

      if (method === "GET" && url.pathname === "/api/projects") {
        return Response.json([{ id: 7, name: "app", status: "running" }]);
      }
      if (method === "GET" && url.pathname === "/api/projects/7/envs") {
        return Response.json([{ key: "A", value: "1" }]);
      }
      if (method === "PUT" && url.pathname === "/api/projects/7/envs") {
        return Response.json([]);
      }
      if (method === "POST" && url.pathname === "/api/projects/7/restart") {
        return Response.json({ message: "Container restarted" });
      }
      throw new Error(`Unexpected request: ${method} ${url.pathname}`);
    }) as typeof fetch;

    await envCommand(["set", "app", "B=2"]);

    expect(calls).toEqual([
      { method: "GET", path: "/api/projects" },
      { method: "GET", path: "/api/projects/7/envs" },
      {
        method: "PUT",
        path: "/api/projects/7/envs",
        body: [
          { key: "A", value: "1" },
          { key: "B", value: "2" },
        ],
      },
      { method: "POST", path: "/api/projects/7/restart" },
    ]);
  });
});
