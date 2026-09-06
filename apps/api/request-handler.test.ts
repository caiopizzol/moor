process.env.MOOR_DB_PATH = ":memory:";

import { afterAll, afterEach, beforeEach, describe, expect, test, spyOn } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { default: db } = await import("./db");
const { handleRequest } = await import("./request-handler");

const originalApiKey = process.env.MOOR_API_KEY;
let upgradeCalls = 0;
const server = {
  upgrade() {
    upgradeCalls++;
    return true;
  },
} as unknown as ReturnType<typeof Bun.serve>;

function completeSetup(): void {
  db.query("INSERT INTO auth (id, password_hash) VALUES (1, 'unused-by-these-tests')").run();
}

function resetAuthState(): void {
  db.query("DELETE FROM sessions").run();
  db.query("DELETE FROM auth").run();
  delete process.env.MOOR_API_KEY;
  upgradeCalls = 0;
}

async function request(path: string, init?: RequestInit): Promise<Response | undefined> {
  return handleRequest(new Request(`http://localhost${path}`, init), server);
}

describe("HTTP authentication boundary", () => {
  beforeEach(resetAuthState);
  afterEach(resetAuthState);

  afterAll(() => {
    if (originalApiKey === undefined) delete process.env.MOOR_API_KEY;
    else process.env.MOOR_API_KEY = originalApiKey;
  });

  test("health remains public before setup", async () => {
    const res = await request("/api/health");
    expect(res?.status).toBe(200);
    expect(await res?.json()).toEqual({ ok: true });
  });

  test("before setup, auth and protected routes fail closed", async () => {
    const auth = await request("/api/auth/status");
    const protectedRoute = await request("/api/server/drain");
    expect(auth?.status).toBe(503);
    expect(protectedRoute?.status).toBe(503);
  });

  test("after setup, auth status remains public but protected routes require authentication", async () => {
    completeSetup();
    const auth = await request("/api/auth/status");
    const protectedRoute = await request("/api/server/drain");
    expect(auth?.status).toBe(200);
    expect(await auth?.json()).toEqual({ authenticated: false });
    expect(protectedRoute?.status).toBe(401);
  });

  test("a valid bearer token reaches the protected route dispatcher", async () => {
    completeSetup();
    process.env.MOOR_API_KEY = "test-api-key";
    const res = await request("/api/server/drain", {
      headers: { Authorization: "Bearer test-api-key" },
    });
    expect(res?.status).toBe(200);
  });

  test("the deploy endpoint is registered behind bearer authentication", async () => {
    completeSetup();
    process.env.MOOR_API_KEY = "test-api-key";
    const unauthorized = await request("/api/deploy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "-invalid", run: false }),
    });
    const authorized = await request("/api/deploy", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-api-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "-invalid", run: false }),
    });

    expect(unauthorized?.status).toBe(401);
    expect(authorized?.status).toBe(400);
    expect(await authorized?.json()).toEqual({
      error: "name must start alphanumeric; allowed chars: a-z A-Z 0-9 _ -",
    });
  });

  test("only a valid session cookie reaches the protected route dispatcher", async () => {
    completeSetup();
    db.query(
      "INSERT INTO sessions (token, expires_at) VALUES ('valid-session', datetime('now', '+1 hour'))",
    ).run();

    const valid = await request("/api/server/drain", {
      headers: { Cookie: "moor_session=valid-session" },
    });
    const forged = await request("/api/server/drain", {
      headers: { Cookie: "moor_session=forged-session" },
    });

    expect(valid?.status).toBe(200);
    expect(forged?.status).toBe(401);
  });

  test("terminal upgrades are rejected before the server upgrade hook", async () => {
    completeSetup();
    const hostTerminal = await request("/api/terminal");
    const projectTerminal = await request("/api/projects/1/terminal");
    expect(hostTerminal?.status).toBe(401);
    expect(projectTerminal?.status).toBe(401);
    expect(upgradeCalls).toBe(0);
  });
});

describe("CLI password sessions", () => {
  beforeEach(async () => {
    resetAuthState();
    const hash = await Bun.password.hash("login-test-password", { algorithm: "argon2id" });
    db.query("INSERT INTO auth (id, password_hash) VALUES (1, ?)").run(hash);
    const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 31_000);
    try {
      expect((await login())?.status).toBe(200);
    } finally {
      clock.mockRestore();
    }
    db.query("DELETE FROM sessions").run();
  });
  afterEach(resetAuthState);

  async function login(path = "/api/auth/token", password: unknown = "login-test-password") {
    return request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
  }

  test("issues a 30-day bearer session and revokes only that session on logout", async () => {
    const res = await login();
    expect(res?.status).toBe(200);
    expect(res?.headers.get("cache-control")).toBe("no-store");
    expect(res?.headers.has("set-cookie")).toBe(false);
    const { token } = (await res!.json()) as { token: string };
    const row = db
      .query("SELECT created_at, expires_at FROM sessions WHERE token = ?")
      .get(token) as { created_at: string; expires_at: string };
    expect(Date.parse(row.expires_at) - Date.parse(row.created_at)).toBe(30 * 24 * 3600_000);
    const other = await login();
    const otherToken = ((await other!.json()) as { token: string }).token;
    const headers = { Authorization: `bEaReR ${token}` };
    expect((await request("/api/server/drain", { headers }))?.status).toBe(200);
    expect((await request("/api/auth/logout", { method: "POST", headers }))?.status).toBe(200);
    expect((await request("/api/server/drain", { headers }))?.status).toBe(401);
    expect(
      (await request("/api/server/drain", { headers: { Authorization: `Bearer ${otherToken}` } }))
        ?.status,
    ).toBe(200);
  });

  test("browser login keeps its 72-hour cookie and logout behavior", async () => {
    const res = await login("/api/auth/login");
    expect(await res!.json()).toEqual({ ok: true });
    const cookie = res!.headers.get("set-cookie")!;
    expect(cookie).toContain("Max-Age=259200");
    const headers = { Cookie: cookie.split(";")[0]! };
    expect((await request("/api/server/drain", { headers }))?.status).toBe(200);
    await request("/api/auth/logout", { method: "POST", headers });
    expect((await request("/api/server/drain", { headers }))?.status).toBe(401);
  });

  test("rejects incorrect and malformed passwords without creating sessions", async () => {
    expect((await login("/api/auth/token", "incorrect"))?.status).toBe(401);
    for (const password of [null, 42, {}, ""])
      expect((await login("/api/auth/token", password))?.status).toBe(400);
    expect((await request("/api/auth/token", { method: "POST", body: "{" }))?.status).toBe(400);
    expect(db.query("SELECT count(*) AS count FROM sessions").get()).toEqual({ count: 0 });
  });

  test("rejects and cleans expired ISO sessions even earlier on the same day", async () => {
    const { cleanExpiredSessions } = await import("./auth");
    const expired = new Date(Date.now() - 1000).toISOString();
    db.query("INSERT INTO sessions (token, expires_at) VALUES (?, ?)").run("expired", expired);
    for (const headers of [
      new Headers({ Authorization: "Bearer expired" }),
      new Headers({ Cookie: "moor_session=expired" }),
    ]) {
      expect((await request("/api/server/drain", { headers }))?.status).toBe(401);
    }
    cleanExpiredSessions();
    expect(db.query("SELECT token FROM sessions WHERE token = 'expired'").get()).toBeNull();
  });

  test("password reset revokes CLI sessions", async () => {
    const res = await login();
    const { token } = (await res!.json()) as { token: string };
    const { checkPasswordReset } = await import("./auth");
    const previous = process.env.MOOR_RESET_PASSWORD;
    try {
      process.env.MOOR_RESET_PASSWORD = "replacement-test-password";
      checkPasswordReset();
      expect(
        (await request("/api/server/drain", { headers: { Authorization: `Bearer ${token}` } }))
          ?.status,
      ).toBe(401);
    } finally {
      if (previous === undefined) delete process.env.MOOR_RESET_PASSWORD;
      else process.env.MOOR_RESET_PASSWORD = previous;
    }
  });
  test("real CLI logs in, reads a protected route, and revokes its session", async () => {
    const directory = mkdtempSync(join(tmpdir(), "moor-auth-e2e-"));
    const http = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        return (await handleRequest(req, server)) ?? new Response(null, { status: 404 });
      },
    });
    async function cli(args: string[], input = "") {
      const child = Bun.spawn({
        cmd: [process.execPath, join(import.meta.dir, "../../packages/cli/src/index.ts"), ...args],
        env: {
          ...process.env,
          XDG_CONFIG_HOME: directory,
          MOOR_URL: undefined,
          MOOR_API_KEY: undefined,
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
    try {
      const loginResult = await cli(
        ["login", http.url.origin, "--password-stdin"],
        "login-test-password\n",
      );
      expect(loginResult.exitCode).toBe(0);
      const path = join(directory, "moor/config.json");
      const { apiKey } = JSON.parse(readFileSync(path, "utf8")) as { apiKey: string };
      const result = await cli(["server", "drain", "status", "--json"]);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toHaveProperty("active_work");
      expect((await cli(["logout"])).exitCode).toBe(0);
      expect(existsSync(path)).toBe(false);
      const rejected = await fetch(new URL("/api/server/drain", http.url), {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      expect(rejected.status).toBe(401);
    } finally {
      await http.stop(true);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("CLI and browser password attempts share the rate limit", async () => {
    await login();
    for (let i = 0; i < 5; i++) {
      expect((await login(i % 2 ? "/api/auth/login" : "/api/auth/token", "wrong"))?.status).toBe(
        401,
      );
    }
    expect((await login())?.status).toBe(429);
    expect((await login("/api/auth/login"))?.status).toBe(429);
    const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 31_000);
    try {
      expect((await login())?.status).toBe(200);
    } finally {
      clock.mockRestore();
    }
  });
});
