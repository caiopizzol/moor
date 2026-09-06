import {
  buildClearCookie,
  buildSessionCookie,
  createSession,
  deleteSession,
  getSessionFromCookie,
  getBearerToken,
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

  const cliLogin = url.pathname === "/api/auth/token";
  if ((url.pathname === "/api/auth/login" || cliLogin) && req.method === "POST") {
    if (!isSetupComplete()) {
      // Should not be reachable: the 503 guard in request-handler.ts blocks /api/* when no admin exists.
      return Response.json({ error: "Admin password not configured" }, { status: 503 });
    }
    const now = Date.now();
    if (now < loginAttempts.lockedUntil) {
      const retryAfter = Math.ceil((loginAttempts.lockedUntil - now) / 1000);
      return Response.json(
        { error: `Too many attempts. Try again in ${retryAfter}s` },
        { status: 429, headers: { "Retry-After": String(retryAfter) } },
      );
    }
    const body: unknown = await req.json().catch(() => null);
    if (
      !body ||
      typeof body !== "object" ||
      !("password" in body) ||
      typeof body.password !== "string" ||
      !body.password
    ) {
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
    loginAttempts.lockedUntil = 0;
    const token = createSession(cliLogin ? 30 * 24 : undefined);
    if (cliLogin) return Response.json({ token }, { headers: { "Cache-Control": "no-store" } });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie": buildSessionCookie(token, req),
      },
    });
  }

  if (url.pathname === "/api/auth/logout" && req.method === "POST") {
    const token = getBearerToken(req) ?? getSessionFromCookie(req);
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
