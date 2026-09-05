import { expect, test } from "bun:test";
import { join } from "node:path";

test("env delete CLI sends one operation and preserves structured partial failures", async () => {
  const calls: Array<{ method: string; path: string; body: unknown; auth: string | null }> = [];
  let fail = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const raw = await req.text();
      calls.push({
        method: req.method,
        path,
        body: raw ? JSON.parse(raw) : null,
        auth: req.headers.get("Authorization"),
      });
      if (path === "/api/projects")
        return Response.json([
          { id: 7, name: "worker" },
          { id: 8, name: "7" },
        ]);
      if (path !== "/api/projects/8/envs/delete" || req.method !== "POST")
        return Response.json({ error: "Wrong endpoint" }, { status: 404 });
      return fail
        ? Response.json(
            {
              error: "restart failed",
              env_updated: true,
              deleted_keys: ["A"],
              missing_keys: [],
              restarted: false,
            },
            { status: 500 },
          )
        : Response.json({ deleted_keys: ["A"], missing_keys: ["missing"], restarted: true });
    },
  });
  const run = async (args: string[]) => {
    const child = Bun.spawn({
      cmd: [process.execPath, join(import.meta.dir, "../index.ts"), "env", "delete", ...args],
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
  };
  try {
    expect(await run(["7", "A", "missing", "--json"])).toEqual({
      exitCode: 0,
      stdout: '{"deleted_keys":["A"],"missing_keys":["missing"],"restarted":true}\n',
      stderr: "",
    });
    expect(calls).toEqual([
      { method: "GET", path: "/api/projects", body: null, auth: "Bearer test-key" },
      {
        method: "POST",
        path: "/api/projects/8/envs/delete",
        body: { keys: ["A", "missing"] },
        auth: "Bearer test-key",
      },
    ]);
    fail = true;
    const failure = await run(["7", "A", "--json"]);
    expect(failure.exitCode).toBe(1);
    expect(failure.stdout).toBe("");
    expect(JSON.parse(failure.stderr)).toMatchObject({
      status: 500,
      env_updated: true,
      deleted_keys: ["A"],
    });
    calls.length = 0;
    for (const args of [["7"], ["7", "--bad"], ["7", ""]]) {
      const result = await run([...args, "--json"]);
      expect(result.exitCode).toBe(1);
      expect(typeof JSON.parse(result.stderr).error).toBe("string");
    }
    expect((await run(["--help"])).exitCode).toBe(0);
    expect(calls).toEqual([]);
    const missing = await run(["nosuch", "A", "--json"]);
    expect(missing.exitCode).toBe(1);
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  } finally {
    await server.stop(true);
  }
});
