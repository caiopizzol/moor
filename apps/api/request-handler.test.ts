process.env.MOOR_DB_PATH = ":memory:";

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";

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
