import { join } from "node:path";
import {
  checkPasswordReset,
  cleanExpiredSessions,
  getSessionFromCookie,
  validateBearerToken,
  validateSession,
} from "./auth";
import { ensureRoutesFile } from "./caddy";
import { interruptActiveRuns, startCronScheduler } from "./cron";
import { hostTerminalHandlers, isHostTerminal, upgradeHostTerminal } from "./host-terminal";
import { handleAuth } from "./routes/auth";
import { handleCaddy } from "./routes/caddy";
import { handleCrons } from "./routes/crons";
import { handleDocker } from "./routes/docker";
import { handleEnvs } from "./routes/envs";
import { handlePorts } from "./routes/ports";
import { handleProjects } from "./routes/projects";
import { handleRuns } from "./routes/runs";
import { handleServer } from "./routes/server";
import { handleTerminalSessions } from "./routes/terminal-sessions";
import { terminalWebSocket, upgradeTerminal } from "./terminal";
import { clearAllSessions, startSessionCleanup } from "./terminal-sessions";

// Initialize DB (side-effect import runs migrations)
import "./db";

checkPasswordReset();
ensureRoutesFile();

const PORT = Number(process.env.PORT || 3000);
const clientDist = join(import.meta.dir, "..", "web", "dist");

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  idleTimeout: 255, // seconds — SSE streams can be silent during long Docker builds

  async fetch(req, server) {
    const url = new URL(req.url);

    // Health check (no auth required)
    if (url.pathname === "/api/health") {
      return Response.json({ ok: true });
    }

    // API routes
    if (url.pathname.startsWith("/api/")) {
      try {
        // Auth routes are always accessible
        const authRes = await handleAuth(req, url);
        if (authRes) return authRes;

        // All other API routes require authentication (session cookie or API key)
        const sessionToken = getSessionFromCookie(req);
        const isAuthed =
          (sessionToken && validateSession(sessionToken)) || validateBearerToken(req);
        if (!isAuthed) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        // WebSocket terminal upgrades — verify Origin header to prevent CSRF
        if (
          url.pathname.match(/^\/api\/projects\/\d+\/terminal$/) ||
          url.pathname === "/api/terminal"
        ) {
          const origin = req.headers.get("origin");
          const host = req.headers.get("host");
          if (origin && host && !origin.includes(host)) {
            return new Response("Origin mismatch", { status: 403 });
          }

          if (url.pathname === "/api/terminal") {
            const wsRes = upgradeHostTerminal(req, server);
            if (wsRes === true) return;
            return wsRes ?? new Response("Upgrade failed", { status: 500 });
          }
          const wsRes = upgradeTerminal(req, server);
          if (wsRes === true) return;
          return wsRes ?? new Response("Upgrade failed", { status: 500 });
        }

        const res =
          (await handleProjects(req, url)) ??
          (await handleDocker(req, url)) ??
          (await handleCrons(req, url)) ??
          (await handleEnvs(req, url)) ??
          (await handlePorts(req, url)) ??
          (await handleRuns(req, url)) ??
          (await handleTerminalSessions(req, url)) ??
          (await handleCaddy(req, url)) ??
          (await handleServer(req, url));

        if (res) return res;
      } catch (e) {
        console.error("[api error]", e);
        const message = e instanceof Error ? e.message : "Internal server error";
        return new Response(JSON.stringify({ error: message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
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
  },

  websocket: {
    open(ws: import("bun").ServerWebSocket<unknown>) {
      console.log(
        `[ws] open handler, data keys: ${Object.keys(ws.data as object).join(",")}, isHost: ${isHostTerminal(ws.data)}`,
      );
      if (isHostTerminal(ws.data)) {
        hostTerminalHandlers.open(ws as never);
      } else {
        terminalWebSocket.open(ws as never);
      }
    },
    message(ws: import("bun").ServerWebSocket<unknown>, message: string | Buffer) {
      if (isHostTerminal(ws.data)) {
        hostTerminalHandlers.message(ws as never, message);
      } else {
        terminalWebSocket.message(ws as never, message);
      }
    },
    close(ws: import("bun").ServerWebSocket<unknown>, code: number, reason: string) {
      if (isHostTerminal(ws.data)) {
        hostTerminalHandlers.close(ws as never);
      } else {
        terminalWebSocket.close(ws as never, code, reason);
      }
    },
  },
});

startCronScheduler();
startSessionCleanup();
setInterval(cleanExpiredSessions, 3600_000);

// Graceful shutdown
const shutdown = () => {
  console.log("[moor] Shutting down...");
  interruptActiveRuns();
  clearAllSessions();
  server.stop();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

console.log(`Moor running at http://localhost:${server.port}`);
