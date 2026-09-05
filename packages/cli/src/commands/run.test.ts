import { expect, test } from "bun:test";
import { join } from "node:path";

type Call = { method: string; path: string; auth: string | null; body?: unknown };
test("run stop uses one direct request and preserves cancellation outcomes in both modes", async () => {
  for (const json of [false, true]) {
    for (const ok of [true, false]) {
      const payload = {
        ok,
        result: ok ? "cancelled_cron" : "cron_kill_incomplete",
        live_remaining: ok ? 0 : 2,
      };
      await fixture(async (run, calls) => {
        expect(await run(["stop", ...(json ? ["--json"] : []), "11"])).toEqual({
          exitCode: ok ? 0 : 1,
          stdout: `${JSON.stringify(payload, null, json ? undefined : 2)}\n`,
          stderr: "",
        });
        expect(calls).toEqual([
          { method: "POST", path: "/api/runs/11/stop", auth: "Bearer test-key", body: {} },
        ]);
      }, payload);
    }
  }
});
test("run stop rejects read options, extra arguments, and invalid IDs before requests", async () => {
  await fixture(async (run, calls) => {
    for (const args of [
      [],
      ["11", "extra"],
      ["11", "--page", "1"],
      ["11", "--tail-bytes", "0"],
      ...["0", "-1", "1.5", "9007199254740992", "bad"].map((id) => [id]),
    ]) {
      const result = await run(["stop", ...args, "--json"]);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(typeof JSON.parse(result.stderr).error).toBe("string");
    }
    expect(calls).toEqual([]);
  });
});
test("run stop preserves HTTP failure details on stderr without retrying", async () => {
  for (const status of [404, 409, 500]) {
    const payload = {
      ok: false,
      result: "cron_kill_incomplete",
      message: "survivors",
      live_remaining: 2,
    };
    await fixture(
      async (run, calls) => {
        const result = await run(["stop", "11", "--json"]);
        expect(result.exitCode).toBe(1);
        expect(result.stdout).toBe("");
        expect(JSON.parse(result.stderr)).toMatchObject({ ...payload, status });
        expect(calls).toHaveLength(1);
      },
      payload,
      status,
    );
  }
});
test("run stop rejects malformed success without retrying an uncertain cancellation", async () => {
  for (const payload of [
    null,
    [],
    {},
    { ok: "true", result: "cancelled" },
    { ok: true, result: " " },
  ]) {
    await fixture(async (run, calls) => {
      const result = await run(["stop", "11", "--json"]);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr).error).toContain("cancellation outcome is unknown");
      expect(calls).toHaveLength(1);
    }, payload);
  }
});
async function fixture(
  check: (
    run: (args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
    calls: Call[],
  ) => Promise<void>,
  payload?: unknown,
  status = 200,
) {
  const calls: Call[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      calls.push({
        method: req.method,
        path: url.pathname + url.search,
        auth: req.headers.get("Authorization"),
        ...(req.method === "POST" ? { body: await req.json() } : {}),
      });
      if (url.pathname === "/api/projects")
        return Response.json([
          { id: 7, name: "worker" },
          { id: 8, name: "7" },
        ]);
      if (payload !== undefined) return Response.json(payload, { status });
      if (url.pathname === "/api/projects/8/runs")
        return Response.json({
          runs: [
            {
              id: 11,
              exit_code: 3,
              started_at: "today",
              finished_at: "today",
              stdout_bytes: 20,
              stderr_bytes: 0,
            },
          ],
          total: 21,
        });
      if (url.pathname === "/api/runs/11")
        return Response.json({
          id: 11,
          exit_code: 3,
          stdout: "abcéXYZ",
          stderr: null,
          stdout_total_bytes: 99,
        });
      return Response.json({ error: "Not found" }, { status: 404 });
    },
  });
  try {
    await check(async (args) => {
      const child = Bun.spawn({
        cmd: [process.execPath, join(import.meta.dir, "../index.ts"), "run", ...args],
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
    }, calls);
  } finally {
    await server.stop(true);
  }
}

test("run list requests paginated summaries with auth and exact-name precedence", async () => {
  await fixture(async (run, calls) => {
    const result = await run(["list", "--page", "2", "7", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      runs: [
        {
          id: 11,
          exit_code: 3,
          started_at: "today",
          finished_at: "today",
          stdout_bytes: 20,
          stderr_bytes: 0,
        },
      ],
      total: 21,
    });
    expect(calls).toEqual([
      { method: "GET", path: "/api/projects", auth: "Bearer test-key" },
      {
        method: "GET",
        path: "/api/projects/8/runs?include_output=false&page=2",
        auth: "Bearer test-key",
      },
    ]);
  });
});
test("run get preserves failed run metadata and trims UTF-8 output without corrupting characters", async () => {
  await fixture(async (run, calls) => {
    const result = await run(["get", "0011", "--tail-bytes", "4", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      id: 11,
      exit_code: 3,
      stdout: "XYZ",
      stderr: null,
      stdout_total_bytes: 99,
      stdout_truncated: true,
      stderr_total_bytes: 0,
      stderr_truncated: false,
    });
    expect(calls).toEqual([{ method: "GET", path: "/api/runs/11", auth: "Bearer test-key" }]);
    const metadata = await run(["get", "11", "--tail-bytes", "0", "--json"]);
    expect(JSON.parse(metadata.stdout).stdout).toBe("");
  });
});
test("run get defaults to a bounded tail", async () => {
  await fixture(
    async (run) => {
      const result = await run(["get", "11", "--json"]);
      expect(result.exitCode).toBe(0);
      const body = JSON.parse(result.stdout);
      expect(body.stdout.length).toBe(8192);
      expect(body.stdout_total_bytes).toBe(9000);
      expect(body.stdout_truncated).toBe(true);
    },
    { id: 11, stdout: "x".repeat(9000), stderr: "" },
  );
});
for (const args of [
  ["list"],
  ["get"],
  ["get", "0"],
  ["get", "1e2"],
  ["get", "9007199254740992"],
  ["list", "7", "--page", "0"],
  ["list", "7", "--page"],
  ["get", "11", "--tail-bytes", "65537"],
  ["get", "11", "--tail-bytes", "-1"],
  ["list", "7", "extra"],
  ["get", "11", "--bad"],
  ["list", "7", "--page", "1", "--page", "2"],
]) {
  test(`run rejects ${args.join(" ")} without requests`, async () => {
    await fixture(async (run, calls) => {
      const result = await run([...args, "--json"]);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(typeof JSON.parse(result.stderr).error).toBe("string");
      expect(calls).toEqual([]);
    });
  });
}
test("run missing project and missing run fail with structured errors", async () => {
  await fixture(async (run, calls) => {
    const project = await run(["list", "missing", "--json"]);
    expect(project.exitCode).toBe(1);
    expect(JSON.parse(project.stderr).error).toContain("not found");
    expect(calls.length).toBe(1);
    const detail = await run(["get", "99", "--json"]);
    expect(detail.exitCode).toBe(1);
    expect(detail.stdout).toBe("");
    expect(JSON.parse(detail.stderr)).toEqual({ error: "Not found", status: 404 });
  });
});
test("run uses shared HTTP error protocol", async () => {
  await fixture(
    async (run) => {
      const result = await run(["get", "11", "--json"]);
      expect(result).toEqual({
        exitCode: 1,
        stdout: "",
        stderr: '{"error":"Unavailable","code":"offline","status":503}\n',
      });
    },
    { error: "Unavailable", code: "offline" },
    503,
  );
});
test("run rejects malformed responses", async () => {
  await fixture(async (run) => {
    for (const args of [
      ["list", "7"],
      ["get", "11"],
    ]) {
      const result = await run([...args, "--json"]);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr).error).toContain("Invalid run");
    }
  }, null);
});
test("run help makes no requests and human list reports empty results", async () => {
  await fixture(
    async (run, calls) => {
      const help = await run(["--help"]);
      expect(help.exitCode).toBe(0);
      expect(help.stdout).toContain("--tail-bytes");
      expect(calls).toEqual([]);
      const result = await run(["list", "7"]);
      expect(result).toEqual({ exitCode: 0, stdout: "0 run(s) on page 1, 0 total\n", stderr: "" });
    },
    { runs: [], total: 0 },
  );
});
