import {
  buildClearCookie,
  buildSessionCookie,
  createSession,
  deleteSession,
  getSessionFromCookie,
  isSetupComplete,
  validateSession,
  verifyPassword,
} from "../auth";

// Simple in-memory rate limiter for login attempts
const loginAttempts = { count: 0, lastAttempt: 0, lockedUntil: 0 };
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 30_000;

export async function handleAuth(req: Request, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/auth")) return null;

  if (url.pathname === "/api/auth/status" && req.method === "GET") {
    const token = getSessionFromCookie(req);
    const authenticated = token ? validateSession(token) : false;
    return Response.json({ authenticated });
  }

  if (url.pathname === "/api/auth/login" && req.method === "POST") {
    if (!isSetupComplete()) {
      // Should not be reachable: the 503 guard in index.ts blocks /api/* when no admin exists.
      return Response.json({ error: "Admin password not configured" }, { status: 503 });
    }
    // Rate limiting
    const now = Date.now();
    if (now < loginAttempts.lockedUntil) {
      const retryAfter = Math.ceil((loginAttempts.lockedUntil - now) / 1000);
      return Response.json(
        { error: `Too many attempts. Try again in ${retryAfter}s` },
        { status: 429, headers: { "Retry-After": String(retryAfter) } },
      );
    }
    const body = (await req.json()) as { password?: string };
    if (!body.password) {
      return Response.json({ error: "Password required" }, { status: 400 });
    }
    const valid = await verifyPassword(body.password);
    if (!valid) {
      loginAttempts.count++;
      loginAttempts.lastAttempt = now;
      if (loginAttempts.count >= MAX_ATTEMPTS) {
        loginAttempts.lockedUntil = now + LOCKOUT_MS;
        loginAttempts.count = 0;
      }
      return Response.json({ error: "Invalid password" }, { status: 401 });
    }
    loginAttempts.count = 0;
    const token = createSession();
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie": buildSessionCookie(token, req),
      },
    });
  }

  if (url.pathname === "/api/auth/logout" && req.method === "POST") {
    const token = getSessionFromCookie(req);
    if (token) deleteSession(token);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie": buildClearCookie(),
      },
    });
  }

  return null;
}
