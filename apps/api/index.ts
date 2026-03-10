import { join } from "node:path";
import {
  checkPasswordReset,
  cleanExpiredSessions,
  getSessionFromCookie,
  validateSession,
} from "./auth";
import { startCronScheduler } from "./cron";
import { hostTerminalHandlers, isHostTerminal, upgradeHostTerminal } from "./host-terminal";
import { handleAuth } from "./routes/auth";
import { handleCrons } from "./routes/crons";
import { handleDocker } from "./routes/docker";
import { handleEnvs } from "./routes/envs";
import { handleProjects } from "./routes/projects";
import { handleRuns } from "./routes/runs";
import { handleServer } from "./routes/server";
import { terminalWebSocket, upgradeTerminal } from "./terminal";

// Initialize DB (side-effect import runs migrations)
import "./db";

checkPasswordReset();

const PORT = Number(process.env.PORT || 3000);
const clientDist = join(import.meta.dir, "..", "web", "dist");

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",

  async fetch(req, server) {
    const url = new URL(req.url);

    // API routes
    if (url.pathname.startsWith("/api/")) {
      try {
        // Auth routes are always accessible
        const authRes = await handleAuth(req, url);
        if (authRes) return authRes;

        // All other API routes require authentication
        const token = getSessionFromCookie(req);
        if (!token || !validateSession(token)) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        // WebSocket terminal upgrades
        if (url.pathname.match(/^\/api\/projects\/\d+\/terminal$/)) {
          const wsRes = upgradeTerminal(req, server);
          if (wsRes === true) return; // upgrade succeeded — must return undefined
          return wsRes ?? new Response("Upgrade failed", { status: 500 });
        }
        if (url.pathname === "/api/terminal") {
          const wsRes = upgradeHostTerminal(req, server);
          if (wsRes === true) return;
          return wsRes ?? new Response("Upgrade failed", { status: 500 });
        }

        const res =
          (await handleProjects(req, url)) ??
          (await handleDocker(req, url)) ??
          (await handleCrons(req, url)) ??
          (await handleEnvs(req, url)) ??
          handleRuns(req, url) ??
          handleServer(req, url);

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
setInterval(cleanExpiredSessions, 3600_000);

console.log(`Moor running at http://localhost:${server.port}`);
