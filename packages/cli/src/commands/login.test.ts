import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let directory: string;
let server: ReturnType<typeof Bun.serve> | undefined;
let requests: string[];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "moor-login-test-"));
  requests = [];
});
afterEach(async () => {
  await server?.stop(true);
  server = undefined;
  rmSync(directory, { recursive: true, force: true });
});

function startServer(fetcher?: (req: Request) => Response | Promise<Response>) {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      requests.push(path);
      if (fetcher) return fetcher(req);
      if (path === "/api/auth/token") {
        const { password } = (await req.json()) as { password: string };
        return password === "test-password"
          ? Response.json({ token: "test-session" })
          : Response.json({ error: "Invalid password" }, { status: 401 });
      }
      if (path === "/api/auth/logout") return Response.json({ ok: true });
      return Response.json({ authorization: req.headers.get("authorization") });
    },
  });
  return server.url.origin;
}

async function cli(args: string[], input = "", env: Record<string, string | undefined> = {}) {
  const child = Bun.spawn({
    cmd: [process.execPath, join(import.meta.dir, "../index.ts"), ...args],
    env: {
      ...process.env,
      XDG_CONFIG_HOME: directory,
      MOOR_URL: undefined,
      MOOR_API_KEY: undefined,
      ...env,
    },
    stdin: new Blob([input]),
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

function configFile() {
  return join(directory, "moor/config.json");
}

async function login(url: string) {
  const result = await cli(["login", url, "--password-stdin"], "test-password\n");
  expect(result.exitCode).toBe(0);
  return result;
}

test("saves an owner-only session without the password and uses it on the next process", async () => {
  const url = startServer();
  const result = await login(url);
  const saved = readFileSync(configFile(), "utf8");
  expect(JSON.parse(saved)).toEqual({ baseUrl: url, apiKey: "test-session" });
  expect(saved).not.toContain("test-password");
  expect(result.stdout + result.stderr).not.toContain("test-session");
  expect(statSync(configFile()).mode & 0o777).toBe(0o600);
  expect(statSync(join(directory, "moor")).mode & 0o777).toBe(0o700);
  const command = await cli(["server", "drain", "status", "--json"]);
  expect(command.exitCode).toBe(0);
  expect(JSON.parse(command.stdout)).toEqual({ authorization: "Bearer test-session" });
  expect((await cli(["logout"])).exitCode).toBe(0);
  expect(existsSync(configFile())).toBe(false);
  expect(requests).toEqual(["/api/auth/token", "/api/server/drain", "/api/auth/logout"]);
});

test("never mixes environment URLs or keys with saved credentials", async () => {
  const url = startServer();
  await login(url);
  const before = requests.length;
  for (const env of [{ MOOR_URL: "https://different.test" }, { MOOR_API_KEY: "override-key" }]) {
    const result = await cli(["server", "drain", "status", "--json"], "", env);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr).error).toContain("is not set");
  }
  expect(requests.length).toBe(before);
  const result = await cli(["server", "drain", "status", "--json"], "", {
    MOOR_URL: url,
    MOOR_API_KEY: "override-key",
  });
  expect(JSON.parse(result.stdout)).toEqual({ authorization: "Bearer override-key" });
});

test("failed login, unsafe URL, unsupported arguments, and non-TTY login do not save credentials", async () => {
  const url = startServer();
  expect((await cli(["login", url, "--password-stdin"], "wrong\n")).exitCode).toBe(1);
  const before = requests.length;
  for (const args of [
    ["login", "http://public.example", "--password-stdin"],
    ["login", url, "--unknown"],
    ["login", url],
  ]) {
    expect((await cli(args)).exitCode).toBe(1);
  }
  expect(requests.length).toBe(before);
  expect(existsSync(configFile())).toBe(false);
});

test("saved-session 401 gives a login instruction and valid JSON", async () => {
  const url = startServer(() => Response.json({ error: "Unauthorized" }, { status: 401 }));
  mkdirSync(join(directory, "moor"));
  writeFileSync(configFile(), JSON.stringify({ baseUrl: url, apiKey: "expired" }));
  const result = await cli(["server", "drain", "status", "--json"]);
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stderr).error).toContain("moor login");
});

test("failed logout retains the session so revocation can be retried", async () => {
  const url = startServer(() => new Response("unavailable", { status: 503 }));
  mkdirSync(join(directory, "moor"));
  writeFileSync(configFile(), JSON.stringify({ baseUrl: url, apiKey: "saved" }));
  const result = await cli(["logout"]);
  expect(result.exitCode).toBe(1);
  expect(existsSync(configFile())).toBe(true);
});

test("does not follow login redirects with a password", async () => {
  const url = startServer((req) => Response.redirect(new URL("/elsewhere", req.url), 307));
  expect((await cli(["login", url, "--password-stdin"], "test-password\n")).exitCode).toBe(1);
  expect(requests).toEqual(["/api/auth/token"]);
});

test("preserves structured upstream authentication failures instead of claiming session expiry", async () => {
  const body = {
    code: "source_credential_required",
    message: "Private repository rejected credentials",
  };
  const url = startServer(() => Response.json(body, { status: 401 }));
  mkdirSync(join(directory, "moor"));
  writeFileSync(configFile(), JSON.stringify({ baseUrl: url, apiKey: "valid-session" }));
  const result = await cli(["server", "drain", "status", "--json"]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("source_credential_required");
  expect(result.stderr).not.toContain("expired");
});

test("concurrent login keeps one credential and revokes the losing session", async () => {
  let issued = 0;
  const revoked: string[] = [];
  const bothArrived = Promise.withResolvers<void>();
  const url = startServer(async (req) => {
    if (new URL(req.url).pathname === "/api/auth/token") {
      const token = `session-${++issued}`;
      if (issued === 2) bothArrived.resolve();
      await bothArrived.promise;
      return Response.json({ token });
    }
    revoked.push(req.headers.get("authorization")!);
    return Response.json({ ok: true });
  });
  const results = await Promise.all([
    cli(["login", url, "--password-stdin"], "test-password\n"),
    cli(["login", url, "--password-stdin"], "test-password\n"),
  ]);
  expect(results.map((result) => result.exitCode).sort((a, b) => a - b)).toEqual([0, 1]);
  const saved = JSON.parse(readFileSync(configFile(), "utf8")) as { apiKey: string };
  expect(revoked).toHaveLength(1);
  expect(revoked[0]).not.toBe(`Bearer ${saved.apiKey}`);
  expect(["session-1", "session-2"]).toContain(saved.apiKey);
});
