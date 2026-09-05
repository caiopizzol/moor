import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const endpoint = "/api/server/source-credentials";
const secret = "credential-private-fixture";
const input = { hostname: "github.com", label: "work", username: "git", secret };
const metadata = {
  id: 8,
  hostname: "github.com",
  label: "work",
  username: "git",
  secret: { configured: true, kind: "unknown" },
  state: "active",
  expires_at: null,
  last_checked_at: null,
  last_check_status: null,
  created_at: "2026-09-05",
  updated_at: "2026-09-05",
};
let server: ReturnType<typeof Bun.serve>;
let directory: string;
let respond: () => Response;
const requests: Array<{ path: string; method: string; auth: string | null; body: unknown }> = [];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "moor-credential-"));
  requests.length = 0;
  respond = () => Response.json(metadata);
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      requests.push({
        path: new URL(req.url).pathname,
        method: req.method,
        auth: req.headers.get("Authorization"),
        body: req.method === "GET" ? null : await req.json(),
      });
      return respond();
    },
  });
});
afterEach(async () => {
  await server.stop(true);
  await rm(directory, { recursive: true, force: true });
});
async function run(args: string[], stdin = "") {
  const child = Bun.spawn({
    cmd: [process.execPath, join(import.meta.dir, "../index.ts"), "credential", ...args],
    env: { ...process.env, MOOR_URL: server.url.origin, MOOR_API_KEY: "test-key" },
    stdin: new Blob([stdin]),
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
test("source check preserves ambiguous credential candidates in JSON stderr", async () => {
  const body = {
    ok: false,
    code: "source_credential_ambiguous",
    hostname: "github.com",
    candidates: [
      { id: 7, label: "personal" },
      { id: 8, label: "work" },
    ],
  };
  respond = () => Response.json(body, { status: 409 });
  expect(
    await run(["source", "check", "--github-url", "https://github.com/acme/app", "--json"]),
  ).toEqual({
    exitCode: 1,
    stdout: "",
    stderr: `${JSON.stringify({ ...body, error: "HTTP 409", status: 409 })}\n`,
  });
  expect(requests).toEqual([
    {
      path: `${endpoint}/check`,
      method: "POST",
      auth: "Bearer test-key",
      body: { github_url: "https://github.com/acme/app" },
    },
  ]);
});
test("source create reads stdin and returns only server metadata", async () => {
  const result = await run(["source", "create", "--file", "-", "--json"], JSON.stringify(input));
  expect(result).toEqual({ exitCode: 0, stdout: `${JSON.stringify(metadata)}\n`, stderr: "" });
  expect(result.stdout + result.stderr).not.toContain(secret);
  expect(requests).toEqual([
    { path: endpoint, method: "POST", auth: "Bearer test-key", body: input },
  ]);
});
test("source create reads a disk file and prints a minimal human summary", async () => {
  const path = join(directory, "credential.json");
  await writeFile(path, JSON.stringify(input));
  expect(await run(["source", "create", "--file", path])).toEqual({
    exitCode: 0,
    stdout: "8\tgithub.com\twork\tactive\n",
    stderr: "",
  });
  expect(requests[0]?.body).toEqual(input);
});
test("source list preserves metadata JSON and handles empty human output", async () => {
  respond = () => Response.json({ rows: [metadata] });
  expect(await run(["source", "list", "--json"])).toEqual({
    exitCode: 0,
    stdout: `${JSON.stringify({ rows: [metadata] })}\n`,
    stderr: "",
  });
  expect(requests).toEqual([
    { path: endpoint, method: "GET", auth: "Bearer test-key", body: null },
  ]);
  respond = () => Response.json({ rows: [] });
  expect((await run(["source", "list"])).stdout).toBe("No source credentials.\n");
});
test("source check forwards explicit selection and preserves the selected credential response", async () => {
  const body = { ok: true, reachable: true, head_sha: "abc" };
  respond = () => Response.json(body);
  expect(
    await run([
      "source",
      "check",
      "--json",
      "--source-credential-id",
      "8",
      "--branch",
      "next",
      "--github-url",
      "https://github.com/acme/app",
    ]),
  ).toEqual({
    exitCode: 0,
    stdout: `${JSON.stringify(body)}\n`,
    stderr: "",
  });
  expect(requests[0]?.body).toEqual({
    github_url: "https://github.com/acme/app",
    branch: "next",
    source_credential_id: 8,
  });
  const selected = { ...body, auto_selected_credential_id: 8 };
  respond = () => Response.json(selected);
  expect(
    await run(["source", "check", "--github-url", "https://github.com/acme/app", "--json"]),
  ).toEqual({
    exitCode: 0,
    stdout: `${JSON.stringify(selected)}\n`,
    stderr: "",
  });
  expect(requests[1]?.body).toEqual({ github_url: "https://github.com/acme/app" });
});
test("source create parse failures never echo credential content", async () => {
  for (const value of [`{"secret":"${secret}"`, "[]", "null", '"value"']) {
    expect(await run(["source", "create", "--file", "-", "--json"], value)).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: '{"error":"Credential file must contain a JSON object"}\n',
    });
  }
  expect(await run(["source", "create", "--file", join(directory, "absent"), "--json"])).toEqual({
    exitCode: 1,
    stdout: "",
    stderr: '{"error":"Unable to read credential file"}\n',
  });
  expect(requests).toEqual([]);
});
test("credential syntax errors and help make no requests", async () => {
  for (const args of [
    [],
    ["registry", "list"],
    ["source", "delete"],
    ["source", "list", "extra"],
    ["source", "create"],
    ["source", "create", "--secret", secret],
    ["source", "create", "--file", "a", "--file", "b"],
    ["source", "create", "--file"],
    ["source", "check"],
    ["source", "check", "--github-url", "url", "--source-credential-id", "0"],
    ["source", "check", "--github-url", "url", "--source-credential-id", "1.5"],
    ["source", "check", "--github-url", "url", "--branch", " "],
  ]) {
    const result = await run([...args, "--json"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(typeof JSON.parse(result.stderr).error).toBe("string");
    expect(result.stderr).not.toContain(secret);
  }
  const help = await run(["--help"]);
  expect(help.exitCode).toBe(0);
  expect(help.stdout).toContain("credential source check");
  expect(requests).toEqual([]);
});
test("source create leaves field validation on the server and preserves errors without secrets", async () => {
  respond = () => Response.json({ error: "hostname is required" }, { status: 400 });
  const result = await run(
    ["source", "create", "--file", "-", "--json"],
    JSON.stringify({ secret }),
  );
  expect(result).toEqual({
    exitCode: 1,
    stdout: "",
    stderr: '{"error":"hostname is required","status":400}\n',
  });
  expect(requests[0]?.body).toEqual({ secret });
  expect(result.stdout + result.stderr).not.toContain(secret);
});
