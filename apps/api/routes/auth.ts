import {
  buildClearCookie,
  buildSessionCookie,
  createSession,
  deleteSession,
  getSessionFromCookie,
  isSetupComplete,
  setupPassword,
  validateSession,
  verifyPassword,
} from "../auth";

export async function handleAuth(req: Request, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/auth")) return null;

  if (url.pathname === "/api/auth/status" && req.method === "GET") {
    const setup = isSetupComplete();
    const token = getSessionFromCookie(req);
    const authenticated = token ? validateSession(token) : false;
    return Response.json({ setup, authenticated });
  }

  if (url.pathname === "/api/auth/setup" && req.method === "POST") {
    if (isSetupComplete()) {
      return Response.json({ error: "Already configured" }, { status: 400 });
    }
    const body = (await req.json()) as { password?: string };
    if (!body.password || body.password.length < 8) {
      return Response.json({ error: "Password must be at least 8 characters" }, { status: 400 });
    }
    await setupPassword(body.password);
    const token = createSession();
    return new Response(JSON.stringify({ ok: true }), {
      status: 201,
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie": buildSessionCookie(token, req),
      },
    });
  }

  if (url.pathname === "/api/auth/login" && req.method === "POST") {
    if (!isSetupComplete()) {
      return Response.json({ error: "Setup required" }, { status: 400 });
    }
    const body = (await req.json()) as { password?: string };
    if (!body.password) {
      return Response.json({ error: "Password required" }, { status: 400 });
    }
    const valid = await verifyPassword(body.password);
    if (!valid) {
      return Response.json({ error: "Invalid password" }, { status: 401 });
    }
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
