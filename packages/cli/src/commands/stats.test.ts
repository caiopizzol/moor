import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";

const stats = {
  hostname: "host",
  os: "Linux",
  uptime: "1h",
  cpu: { percent: 12, cores: 4 },
  memory: { total: "8 GB", used: "2 GB", percent: 25 },
  disk: { total: "100 GB", used: "10 GB", percent: 10 },
  disks: [{ mount: "/", total: "100 GB", used: "10 GB", percent: 10, label: "root" }],
  containers: { running: 2, total: 3 },
  load: { one_min: 0.5, cores: 4, normalized_percent: 12.5 },
  docker: null,
};
let server: ReturnType<typeof Bun.serve>;
let response: () => Response;
const requests: Array<{ path: string; method: string; auth: string | null }> = [];
beforeEach(() => {
  requests.length = 0;
  response = () => Response.json(stats);
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      requests.push({
        path: new URL(req.url).pathname,
        method: req.method,
        auth: req.headers.get("Authorization"),
      });
      return response();
    },
  });
});
afterEach(async () => {
  await server.stop(true);
});
async function run(args: string[]) {
  const child = Bun.spawn({
    cmd: [process.execPath, join(import.meta.dir, "../index.ts"), "stats", ...args],
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
test("stats JSON preserves the full response and authenticated endpoint", async () => {
  expect(await run(["--json"])).toEqual({
    exitCode: 0,
    stdout: `${JSON.stringify(stats)}\n`,
    stderr: "",
  });
  expect(requests).toEqual([{ path: "/api/server/stats", method: "GET", auth: "Bearer test-key" }]);
});
test("stats keeps human summary and legacy disk fallback", async () => {
  const result = await run([]);
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toBe(
    "Host:        host\nOS:          Linux\nUptime:      1h\nCPU:         12% (4 cores)\nMemory:      2 GB / 8 GB (25%)\nDisk:        root (/)  10 GB / 100 GB (10%)\nContainers:  2 running / 3 total\n",
  );
  response = () => Response.json({ ...stats, disks: undefined });
  expect((await run([])).stdout).toContain("Disk:        /  10 GB / 100 GB (10%)");
});
test("stats request failures use stderr and nonzero exit in both modes", async () => {
  response = () => Response.json({ error: "unavailable", code: "BUSY" }, { status: 503 });
  const json = await run(["--json"]);
  expect(json.exitCode).toBe(1);
  expect(json.stdout).toBe("");
  expect(JSON.parse(json.stderr)).toEqual({ error: "unavailable", code: "BUSY", status: 503 });
  const human = await run([]);
  expect(human.exitCode).toBe(1);
  expect(human.stdout).toBe("");
  expect(human.stderr).toContain("Failed to get stats: unavailable");
});
test("stats rejects extra arguments before requests and help takes precedence", async () => {
  for (const arg of ["bogus", "--unknown", ""]) {
    const result = await run([arg, "--json"]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr).error).toContain("Unexpected argument");
  }
  expect((await run(["--help", "--unknown"])).stdout).toBe("Usage: moor stats [--json]\n");
  expect(requests).toEqual([]);
});
test("stats handles invalid JSON and malformed human payloads without runtime crashes", async () => {
  response = () => new Response("not JSON");
  const result = await run(["--json"]);
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(typeof JSON.parse(result.stderr).error).toBe("string");
  response = () => Response.json(null);
  expect(await run([])).toEqual({
    exitCode: 1,
    stdout: "",
    stderr: "Error: Invalid stats response\n",
  });
});
