import { expect, test } from "bun:test";
import { join } from "node:path";

test("rebuild CLI streams JSONL and fails safely across request and stream errors", async () => {
  const requests: Array<{ method: string; path: string; auth: string | null }> = [];
  let mode = "success";
  const events = (items: Array<[string, unknown]>) =>
    items.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push({
        method: request.method,
        path: url.pathname + url.search,
        auth: request.headers.get("Authorization"),
      });
      if (url.pathname === "/api/projects")
        return Response.json([
          { id: 7, name: "worker" },
          { id: 8, name: "7" },
        ]);
      if (request.method !== "POST" || url.pathname !== "/api/projects/8/run") {
        return Response.json({ error: "Unexpected request" }, { status: 404 });
      }
      if (mode === "http")
        return Response.json({ error: "Draining", code: "drain" }, { status: 503 });
      const body =
        mode === "success"
          ? events([
              ["log", "building\n"],
              ["done", "Container started"],
            ])
          : mode === "structured"
            ? events([["structured-error", { code: "build_failed", message: "Build failed" }]])
            : mode === "error"
              ? events([["error", "Build failed"]])
              : mode === "malformed"
                ? "event: log\ndata: invalid-json\n\n"
                : events([["log", "building\n"]]);
      let offset = 0;
      return new Response(
        new ReadableStream({
          pull(controller) {
            if (offset === body.length) {
              controller.close();
              return;
            }
            controller.enqueue(new TextEncoder().encode(body.slice(offset, offset + 3)));
            offset = Math.min(body.length, offset + 3);
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });
  const run = async (args: string[]) => {
    const child = Bun.spawn({
      cmd: [process.execPath, join(import.meta.dir, "../index.ts"), "rebuild", ...args],
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
    const success = await run(["7", "--no-cache", "--json"]);
    expect(success).toEqual({
      exitCode: 0,
      stdout: '{"event":"log","data":"building\\n"}\n{"event":"done","data":"Container started"}\n',
      stderr: "",
    });
    expect(requests).toEqual([
      { method: "GET", path: "/api/projects", auth: "Bearer test-key" },
      { method: "POST", path: "/api/projects/8/run?nocache=true", auth: "Bearer test-key" },
    ]);
    requests.length = 0;
    expect(await run(["7"])).toEqual({
      exitCode: 0,
      stdout: "Rebuilding 7...\nbuilding\nContainer started\n",
      stderr: "",
    });
    expect(requests[1]?.path).toBe("/api/projects/8/run");
    mode = "http";
    expect(await run(["7", "--json"])).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: '{"error":"Draining","code":"drain","status":503}\n',
    });
    for (const failure of ["structured", "error", "truncated", "malformed"]) {
      mode = failure;
      const result = await run(["--json", "7"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe("");
      const lines = result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(["error", "structured-error"]).toContain(lines.at(-1).event);
    }
    mode = "structured";
    expect(await run(["7"])).toEqual({
      exitCode: 1,
      stdout: "Rebuilding 7...\n",
      stderr: "Error [build_failed]: Build failed\n",
    });
    requests.length = 0;
    for (const [args, error] of [
      [["--json"], "Project is required"],
      [["7", "extra", "--json"], "Unexpected argument: extra"],
      [["7", "--unknown", "--json"], "Unknown option: --unknown"],
    ] as const) {
      expect(await run([...args])).toEqual({
        exitCode: 1,
        stdout: "",
        stderr: `${JSON.stringify({ error })}\n`,
      });
    }
    const help = await run(["--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("{event,data}");
    expect(requests).toEqual([]);
    expect(await run(["missing", "--json"])).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: '{"error":"Project \\"missing\\" not found"}\n',
    });
    expect(requests.map(({ method }) => method)).toEqual(["GET"]);
  } finally {
    await server.stop(true);
  }
});
