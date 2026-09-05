import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

describe("stop CLI", () => {
  let server: ReturnType<typeof Bun.serve>;
  let projects: unknown;
  let fail: boolean;
  const calls: Array<{ method: string; path: string; auth: string | null }> = [];

  beforeEach(() => {
    calls.length = 0;
    fail = false;
    projects = [
      { id: 7, name: "decoy" },
      { id: 8, name: "7" },
    ];
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        calls.push({ method: req.method, path, auth: req.headers.get("Authorization") });
        if (path === "/api/projects") return Response.json(projects);
        if (path !== "/api/projects/8/stop" || req.method !== "POST")
          return Response.json({ error: "Wrong endpoint" }, { status: 404 });
        return fail
          ? Response.json({ error: "Docker unavailable", code: "DOCKER" }, { status: 500 })
          : Response.json({ message: "Container stopped" });
      },
    });
  });
  afterEach(async () => {
    await server.stop(true);
  });

  async function run(args: string[]) {
    const child = Bun.spawn({
      cmd: [process.execPath, join(import.meta.dir, "../index.ts"), "stop", ...args],
      env: { ...process.env, MOOR_URL: server.url.origin, MOOR_API_KEY: "test-key" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  }

  test("uses exact numeric name before ID and sends only one stop mutation", async () => {
    expect(await run(["7", "--json"])).toEqual({
      exitCode: 0,
      stdout: '{"message":"Container stopped"}\n',
      stderr: "",
    });
    expect(calls).toEqual([
      { method: "GET", path: "/api/projects", auth: "Bearer test-key" },
      { method: "POST", path: "/api/projects/8/stop", auth: "Bearer test-key" },
    ]);
  });
  test("accepts numeric ID and leading JSON flag", async () => {
    expect((await run(["--json", "8"])).exitCode).toBe(0);
    expect(calls[1]?.path).toBe("/api/projects/8/stop");
  });
  test("prints human success", async () => {
    expect(await run(["7"])).toEqual({ exitCode: 0, stdout: "7 stopped.\n", stderr: "" });
  });
  test("preserves API errors on stderr and exits nonzero", async () => {
    fail = true;
    const result = await run(["7", "--json"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      error: "Docker unavailable",
      code: "DOCKER",
      status: 500,
    });
    const human = await run(["7"]);
    expect(human.exitCode).toBe(1);
    expect(human.stdout).toBe("");
    expect(human.stderr).toContain("Docker unavailable");
  });
  test("rejects invalid arguments before any request", async () => {
    for (const args of [[], ["7", "extra"], ["7", "--unknown"], [""]]) {
      const result = await run([...args, "--json"]);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(typeof JSON.parse(result.stderr).error).toBe("string");
    }
    expect(calls).toEqual([]);
  });
  test("help wins without making requests", async () => {
    const result = await run(["--help", "--unknown"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("moor stop <project> [--json]");
    expect(result.stderr).toBe("");
    expect(calls).toEqual([]);
  });
  test("missing project never stops another project", async () => {
    const result = await run(["missing", "--json"]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr).error).toContain("not found");
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
  });
  test("malformed listings fail without mutation", async () => {
    for (const body of [null, {}, [null], [{ id: "8", name: "7" }]]) {
      projects = body;
      calls.length = 0;
      const result = await run(["7", "--json"]);
      expect(result).toEqual({
        exitCode: 1,
        stdout: "",
        stderr: '{"error":"Invalid project response"}\n',
      });
      expect(calls.map((call) => call.method)).toEqual(["GET"]);
    }
  });
});
