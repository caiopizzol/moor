import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";

const history = {
  from_ms: 0,
  to_ms: 3600000,
  samples: [],
  events: [],
  summary: {
    sample_count: 0,
    running_sample_count: 0,
    cpu_percent_avg: null,
    cpu_percent_max: null,
    mem_bytes_max: null,
    net_rx_bytes_total: 0,
    net_tx_bytes_total: 0,
    event_counts: {},
    has_gap: false,
  },
};
let server: ReturnType<typeof Bun.serve>;
let projects: unknown;
let respond: () => Response;
const requests: Array<{ url: URL; auth: string | null }> = [];
beforeEach(() => {
  requests.length = 0;
  projects = [
    { id: 7, name: "decoy" },
    { id: 8, name: "7" },
  ];
  respond = () => Response.json(history);
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      requests.push({ url, auth: req.headers.get("Authorization") });
      return url.pathname === "/api/projects" ? Response.json(projects) : respond();
    },
  });
});
afterEach(async () => {
  await server.stop(true);
});
async function run(args: string[]) {
  const child = Bun.spawn({
    cmd: [process.execPath, join(import.meta.dir, "../index.ts"), "history", ...args],
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
test("history JSON preserves API payload, exact name precedence, auth and requested window", async () => {
  for (const args of [
    ["7", "--json"],
    ["--json", "--hours", "2", "7"],
    ["7", "--hours=0.5", "--json"],
  ]) {
    requests.length = 0;
    expect(await run(args)).toEqual({
      exitCode: 0,
      stdout: `${JSON.stringify(history)}\n`,
      stderr: "",
    });
    expect(requests.map((r) => r.url.pathname)).toEqual([
      "/api/projects",
      "/api/projects/8/stats/history",
    ]);
    expect(requests.every((r) => r.auth === "Bearer test-key")).toBe(true);
    const query = requests[1]?.url.searchParams;
    if (!query) throw new Error("Expected history request");
    const expectedHours = args.includes("2") ? 2 : args.includes("--hours=0.5") ? 0.5 : 24;
    expect(Number(query.get("to")) - Number(query.get("from"))).toBe(expectedHours * 3600000);
  }
});
test("history treats repeated JSON flags as idempotent like the shared project parser", async () => {
  expect(await run(["--json", "7", "--json"])).toEqual({
    exitCode: 0,
    stdout: `${JSON.stringify(history)}\n`,
    stderr: "",
  });
  expect(requests.map((request) => request.url.pathname)).toEqual([
    "/api/projects",
    "/api/projects/8/stats/history",
  ]);
});

test("history human summary remains readable with no stored samples", async () => {
  expect(await run(["7"])).toEqual({
    exitCode: 0,
    stderr: "",
    stdout:
      "7 — history over ~1h\n  Samples:   0 total, 0 running\n  CPU:       avg n/a% / max n/a%\n  Memory:    max n/a\n  Network:   in 0 B / out 0 B\n  (no stored history in this window)\n",
  });
});
test("history malformed human payload produces no partial output", async () => {
  respond = () => Response.json(null);
  expect(await run(["7"])).toEqual({
    exitCode: 1,
    stdout: "",
    stderr: "Error: Invalid history response\n",
  });
});
test("history rejects invalid arguments and duplicate hours before requests", async () => {
  for (const args of [
    [],
    ["7", "extra"],
    ["7", "--bad"],
    ["7", "--hours"],
    ["7", "--hours", "-1"],
    ["7", "--hours=1e308"],
    ["7", "--hours=1", "--hours", "2"],
  ]) {
    const result = await run([...args, "--json"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(typeof JSON.parse(result.stderr).error).toBe("string");
  }
  expect(requests).toEqual([]);
});
test("history help does not need a configured project", async () => {
  const result = await run(["--help", "--bad"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("[--json]");
  expect(requests).toEqual([]);
});
test("history missing and malformed projects make no history request", async () => {
  for (const body of [[], [{ id: 8, name: " " }], null]) {
    projects = body;
    requests.length = 0;
    const result = await run(["8", "--json"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(typeof JSON.parse(result.stderr).error).toBe("string");
    expect(requests.map((r) => r.url.pathname)).toEqual(["/api/projects"]);
  }
});
test("history preserves API error details and exits nonzero", async () => {
  respond = () => Response.json({ error: "unavailable", code: "BUSY" }, { status: 503 });
  const result = await run(["7", "--json"]);
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(JSON.parse(result.stderr)).toEqual({ error: "unavailable", code: "BUSY", status: 503 });
  const human = await run(["7"]);
  expect(human.exitCode).toBe(1);
  expect(human.stdout).toBe("");
  expect(human.stderr).toContain("unavailable");
});
