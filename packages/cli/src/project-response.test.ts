import { expect, test } from "bun:test";
import { join } from "node:path";

for (const args of [
  ["project", "list"],
  ["project", "get", "8"],
  ["status"],
  ["restart", "8"],
  ["rebuild", "8"],
  ["stop", "8"],
  ["exec", "8", "--json", "--", "true"],
  ["logs", "8"],
  ["env", "list", "8"],
  ["env", "delete", "8", "A"],
  ["env", "set", "8", "--env-file", "-"],
  ["run", "list", "8"],
]) {
  test(`${args.join(" ")} rejects malformed project lists before further requests`, async () => {
    let body: unknown;
    const paths: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        paths.push(new URL(req.url).pathname);
        return Response.json(body);
      },
    });
    try {
      for (const malformed of [
        null,
        {},
        [null],
        [{ id: 8, name: "" }],
        [{ id: 8, name: "  " }],
        [{ id: "8", name: "app" }],
      ]) {
        body = malformed;
        paths.length = 0;
        const commandArgs = args.includes("--json") ? args : [...args, "--json"];
        const child = Bun.spawn({
          cmd: [process.execPath, join(import.meta.dir, "index.ts"), ...commandArgs],
          env: { ...process.env, MOOR_URL: server.url.origin, MOOR_API_KEY: "test-key" },
          stdin: new Blob(['{"A":"value"}']),
          stdout: "pipe",
          stderr: "pipe",
        });
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(code).toBe(1);
        expect(stdout).toBe("");
        expect(JSON.parse(stderr)).toEqual({ error: "Invalid project response" });
        expect(paths).toEqual(["/api/projects"]);
      }
    } finally {
      await server.stop(true);
    }
  });
}
