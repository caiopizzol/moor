import { join } from "node:path";
import {
  getSessionFromCookie,
  isSetupComplete,
  validateBearerToken,
  validateSession,
} from "./auth";
import { upgradeHostTerminal } from "./host-terminal";
import { errorResponse } from "./http";
import { handleAuth } from "./routes/auth";
import { handleCaddy } from "./routes/caddy";
import { handleCleanup } from "./routes/cleanup";
import { handleContainerStats } from "./routes/container-stats";
import { handleCrons } from "./routes/crons";
import { handleDocker } from "./routes/docker";
import { handleEnvs } from "./routes/envs";
import { handleExec } from "./routes/exec";
import { handleFiles } from "./routes/files";
import { handlePorts } from "./routes/ports";
import { handleProjectHistory } from "./routes/project-history";
import { handleProjects } from "./routes/projects";
import { handleRegistryCredentials } from "./routes/registry-credentials";
import { handleRuns } from "./routes/runs";
import { handleServer } from "./routes/server";
import { handleSourceCredentials } from "./routes/source-credentials";
import { handleTerminalSessions } from "./routes/terminal-sessions";
import { handleVolumes } from "./routes/volumes";
import { upgradeTerminal } from "./terminal";

const clientDist = join(import.meta.dir, "..", "web", "dist");

export async function handleRequest(
  req: Request,
  server: ReturnType<typeof Bun.serve>,
): Promise<Response | undefined> {
  const url = new URL(req.url);

  // Health check (no auth required)
  if (url.pathname === "/api/health") {
    return Response.json({ ok: true });
  }

  // API routes
  if (url.pathname.startsWith("/api/")) {
    // Fail closed if no admin password is configured. Health is intentionally
    // unaffected so the Docker healthcheck can still mark the container ready.
    if (!isSetupComplete()) {
      return Response.json(
        {
          error: "Admin password is not configured. Set MOOR_INITIAL_PASSWORD in .env and restart.",
        },
        { status: 503 },
      );
    }
    try {
      // Auth routes are always accessible after setup.
      const authRes = await handleAuth(req, url);
      if (authRes) return authRes;

      // All other API routes require authentication (session cookie or API key).
      const sessionToken = getSessionFromCookie(req);
      const isAuthed = (sessionToken && validateSession(sessionToken)) || validateBearerToken(req);
      if (!isAuthed) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }

      // WebSocket terminal upgrades — verify Origin header to prevent CSRF.
      if (
        url.pathname.match(/^\/api\/projects\/\d+\/terminal$/) ||
        url.pathname === "/api/terminal"
      ) {
        const origin = req.headers.get("origin");
        const host = req.headers.get("host");
        if (origin && host && !origin.includes(host)) {
          return errorResponse("Origin mismatch", 403);
        }

        if (url.pathname === "/api/terminal") {
          const wsRes = upgradeHostTerminal(req, server);
          if (wsRes === true) return;
          return wsRes ?? new Response("Upgrade failed", { status: 500 });
        }
        const wsRes = await upgradeTerminal(req, server);
        if (wsRes === true) return;
        return wsRes ?? new Response("Upgrade failed", { status: 500 });
      }

      const res =
        (await handleProjects(req, url)) ??
        (await handleVolumes(req, url)) ??
        (await handleFiles(req, url)) ??
        (await handleExec(req, url)) ??
        (await handleDocker(req, url)) ??
        (await handleCrons(req, url)) ??
        (await handleEnvs(req, url)) ??
        (await handlePorts(req, url)) ??
        (await handleRuns(req, url)) ??
        (await handleTerminalSessions(req, url)) ??
        (await handleCaddy(req, url)) ??
        (await handleCleanup(req, url)) ??
        (await handleProjectHistory(req, url)) ??
        (await handleContainerStats(req, url)) ??
        (await handleRegistryCredentials(req, url)) ??
        (await handleSourceCredentials(req, url)) ??
        (await handleServer(req, url));

      if (res) return res;
    } catch (e) {
      console.error("[api error]", e);
      const message = e instanceof Error ? e.message : "Internal server error";
      return errorResponse(message, 500);
    }
    return errorResponse("Not found", 404);
  }

  // Serve built client (production)
  if (url.pathname !== "/" && url.pathname !== "/index.html") {
    const file = Bun.file(join(clientDist, url.pathname));
    if (await file.exists()) return new Response(file);
  }

  // SPA fallback
  const index = Bun.file(join(clientDist, "index.html"));
  if (await index.exists()) return new Response(index);

  return new Response("Run 'bun run build' in client/ first", { status: 503 });
}
