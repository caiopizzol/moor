import { afterEach, describe, expect, test } from "bun:test";
import { restartCommand } from "./restart";

const originalFetch = globalThis.fetch;
const originalMoorUrl = process.env.MOOR_URL;
const originalMoorApiKey = process.env.MOOR_API_KEY;

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv("MOOR_URL", originalMoorUrl);
  restoreEnv("MOOR_API_KEY", originalMoorApiKey);
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("restart command", () => {
  test("delegates restart orchestration to the API", async () => {
    process.env.MOOR_URL = "https://moor.test";
    process.env.MOOR_API_KEY = "test-key";
    const calls: Array<{ method: string; path: string }> = [];
    const output: string[] = [];

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      const method = init?.method ?? "GET";
      calls.push({ method, path: url.pathname });

      if (method === "GET" && url.pathname === "/api/projects") {
        return Response.json([
          {
            id: 7,
            name: "app",
            status: "running",
            github_url: null,
            docker_image: "nginx:alpine",
          },
        ]);
      }
      if (method === "POST" && url.pathname === "/api/projects/7/restart") {
        return Response.json({ message: "Container restarted" });
      }
      throw new Error(`Unexpected request: ${method} ${url.pathname}`);
    }) as typeof fetch;

    expect(
      await restartCommand(["app"], {
        stdout: (text) => output.push(text),
        stderr: (text) => {
          throw new Error(text);
        },
      }),
    ).toBe(0);

    expect(calls).toEqual([
      { method: "GET", path: "/api/projects" },
      { method: "POST", path: "/api/projects/7/restart" },
    ]);
    expect(output).toEqual(["Restarting app...\n", "app restarted.\n"]);
  });
});
