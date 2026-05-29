import { join } from "node:path";
import {
  checkInitialPassword,
  checkPasswordReset,
  cleanExpiredSessions,
  getSessionFromCookie,
  isSetupComplete,
  validateBearerToken,
  validateSession,
} from "./auth";
import { activeBuildRuns, interruptActiveBuildRuns } from "./build-runs";
import { ensureRoutesFile } from "./caddy";
import { startCleanupScheduler, stopCleanupScheduler } from "./cleanup-scheduler";
import { interruptActiveRuns, startCronScheduler, stopCronScheduler } from "./cron";
// Initialize DB (side-effect import runs migrations)
import db from "./db";
import { startBackupScheduler, stopBackupScheduler } from "./db-backup";
import { startDockerEventConsumer, stopDockerEventConsumer } from "./docker-events";
import { maybeAutoClearForBoot } from "./drain";
import { interruptActiveExecRuns } from "./exec-async";
import { hostTerminalHandlers, isHostTerminal, upgradeHostTerminal } from "./host-terminal";
import { type HostSample, startMetricsSampler, stopMetricsSampler } from "./metrics-sampler";
import { handleAuth } from "./routes/auth";
import { handleCaddy } from "./routes/caddy";
import { handleCleanup } from "./routes/cleanup";
import { handleContainerStats } from "./routes/container-stats";
import { handleCrons } from "./routes/crons";
import { handleDocker } from "./routes/docker";
import { handleEnvs } from "./routes/envs";
import { handleExec } from "./routes/exec";
import { handlePorts } from "./routes/ports";
import { handleProjects } from "./routes/projects";
import { handleRegistryCredentials } from "./routes/registry-credentials";
import { handleRuns } from "./routes/runs";
import { getServerStats, handleServer } from "./routes/server";
import { handleSourceCredentials } from "./routes/source-credentials";
import { handleTerminalSessions } from "./routes/terminal-sessions";
import { handleVolumes } from "./routes/volumes";
import {
  reconcileProjectStatusAfterInterrupt,
  startStatusReconciler,
  stopStatusReconciler,
} from "./status-reconciler";
import { terminalWebSocket, upgradeTerminal } from "./terminal";
import { clearAllSessions, startSessionCleanup } from "./terminal-sessions";
import { sweepAllArtifacts } from "./update-artifacts";
import { sweepStaleInProgress } from "./update-audit";
import {
  defaultMarkerDir,
  ingestAllMarkers,
  startMarkerPoller,
  stopMarkerPoller,
} from "./update-marker";

checkInitialPassword();
checkPasswordReset();
ensureRoutesFile();
// #79: if drain was enabled with clear_after_version for an upgrade, and the
// upgrade actually landed (running version === clear_after_version), the row
// auto-clears here so post-upgrade boot starts in a normal serving state.
// Mismatched version (failed upgrade) keeps the drain — TTL or operator
// intervention required.
maybeAutoClearForBoot();
// #80 PR #2: ingest any respawner-result markers that landed during
// downtime BEFORE the in_progress sweep runs. The order matters: a
// valid success/rolled_back marker for a row >30min old must beat the
// sweep, otherwise the sweep would mark it 'crashed' first and the
// marker would then no-op (finalizeAudit's WHERE state='in_progress'
// guard). The boot-order test in update-marker.test.ts codifies this.
{
  const dir = defaultMarkerDir();
  if (dir !== "") {
    const ingestResults = ingestAllMarkers(dir);
    if (ingestResults.length > 0) {
      console.log(
        `[update-marker] boot ingest: ${ingestResults.length} marker(s); kinds: ${ingestResults
          .map((r) => r.kind)
          .join(",")}`,
      );
    }
  }
}
// #80 PR #1: one-shot sweep at boot for any update_audit row left
// 'in_progress' past the 30-min grace window — happens when a respawner
// crashed before writing its marker, OR no respawner ever ran but a row
// was somehow orphaned. Runs AFTER ingest above so a valid late marker
// gets its chance first. Logs the IDs swept so an operator can dig in.
{
  const sweptIds = sweepStaleInProgress();
  if (sweptIds.length > 0) {
    console.warn(
      `[update-audit] swept ${sweptIds.length} stale 'in_progress' row(s) to 'crashed': ${sweptIds.join(", ")}`,
    );
  }
}
// #98: one-shot sweep at boot for context/override/rollback artifacts
// whose audit row is now in a terminal state. Runs AFTER the stale-
// audit sweep so a row just transitioned to 'crashed' also gets its
// artifacts cleaned in the same boot. The common-path cleanup happens
// inline on each marker ingest (sweepArtifactsForAudit); this catches
// rows finalized outside that path (operator SQL, crash recovery,
// pre-#98 history).
{
  const dir = defaultMarkerDir();
  if (dir !== "") {
    const r = sweepAllArtifacts(dir);
    if (r.deleted.length > 0) {
      console.log(`[update-artifacts] boot sweep deleted ${r.deleted.length} stale artifact(s)`);
    }
    if (r.skipped_unknown_audit.length > 0) {
      console.warn(
        `[update-artifacts] ${r.skipped_unknown_audit.length} artifact(s) reference unknown audit_id(s): ${r.skipped_unknown_audit.join(",")} (manual cleanup only; see #98)`,
      );
    }
  }
}

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
      // Fail closed if no admin password is configured. Health is intentionally
      // unaffected so the Docker healthcheck can still mark the container ready.
      if (!isSetupComplete()) {
        return Response.json(
          {
            error:
              "Admin password is not configured. Set MOOR_INITIAL_PASSWORD in .env and restart.",
          },
          { status: 503 },
        );
      }
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
          const wsRes = await upgradeTerminal(req, server);
          if (wsRes === true) return;
          return wsRes ?? new Response("Upgrade failed", { status: 500 });
        }

        const res =
          (await handleProjects(req, url)) ??
          (await handleVolumes(req, url)) ??
          (await handleExec(req, url)) ??
          (await handleDocker(req, url)) ??
          (await handleCrons(req, url)) ??
          (await handleEnvs(req, url)) ??
          (await handlePorts(req, url)) ??
          (await handleRuns(req, url)) ??
          (await handleTerminalSessions(req, url)) ??
          (await handleCaddy(req, url)) ??
          (await handleCleanup(req, url)) ??
          (await handleContainerStats(req, url)) ??
          (await handleRegistryCredentials(req, url)) ??
          (await handleSourceCredentials(req, url)) ??
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
startCleanupScheduler();
startStatusReconciler();
startBackupScheduler();
// #131: project observability sampler. Sibling loop to the reconciler (kept
// separate so the heavier stats call can't delay lifecycle freshness). The
// host fetcher reuses the server route's gatherer, projecting it onto the
// percent-gauge HostSample shape.
startMetricsSampler(async (): Promise<HostSample | null> => {
  try {
    const s = await getServerStats();
    return {
      cpu_percent: s.cpu.percent,
      cpu_cores: s.cpu.cores,
      mem_percent: s.memory.percent,
      disk_percent: s.disk.percent,
      containers_running: s.containers.running,
      containers_total: s.containers.total,
    };
  } catch {
    return null;
  }
});
// #131: Docker /events consumer — primary lifecycle-event source (the poll is
// the backstop). Self-reconnecting; safe to start unconditionally.
startDockerEventConsumer();
// #80 PR #2: background poller for respawner-result markers. Fast
// 5s ticks for the first 2 min after boot (catches markers landing
// post-startup), then slow 30s thereafter.
startMarkerPoller();

// #77: async-tolerant shutdown coordinator. Order matters: stop the
// schedulers and HTTP server first so no NEW work is scheduled or
// accepted, then interrupt active work with truthful terminal-state
// reasons (not generic "user cancelled"), then yield briefly so the
// fetch aborts can propagate before the process dies. 5s hard cap so
// a stuck cleanup can't block SIGTERM indefinitely.
//
// Async exec is deliberately out of scope here (see ticket #77's
// scope-correction comment) — exec-async.ts keeps active state private
// and needs a separate interrupt API.
const SHUTDOWN_HARD_TIMEOUT_MS = 5_000;
let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("[moor] Shutting down...");

  const hardExit = setTimeout(() => {
    console.error("[moor] shutdown hard-timeout hit; forcing exit");
    process.exit(1);
  }, SHUTDOWN_HARD_TIMEOUT_MS);
  hardExit.unref?.();

  try {
    // Stop all schedulers first so nothing kicks off NEW work while
    // we're interrupting in-flight. Cron is included now (previously
    // missed — left a race where a tick could land work during the
    // drain window).
    stopCleanupScheduler();
    stopBackupScheduler();
    stopMarkerPoller();
    stopStatusReconciler();
    stopMetricsSampler();
    stopDockerEventConsumer();
    stopCronScheduler();
    server.stop();

    // Snapshot project IDs + container IDs BEFORE interrupting, because
    // interruptActiveBuildRuns removes entries from activeBuildRuns
    // (via each finalize). We need the container_id to reconcile each
    // project's status afterward.
    const interruptedTargets: Array<{ projectId: number; containerId: string | null }> = [];
    for (const run of activeBuildRuns.values()) {
      const project = db
        .query("SELECT container_id FROM projects WHERE id = ?")
        .get(run.projectId) as { container_id: string | null } | null;
      interruptedTargets.push({
        projectId: run.projectId,
        containerId: project?.container_id ?? null,
      });
    }

    const interruptedProjectIds = interruptActiveBuildRuns(
      "[moor shutting down; build/pull aborted]",
    );
    interruptActiveRuns();
    // #82: async exec wasn't covered by #77 because exec-async kept active
    // state private and needed a Docker kill round-trip per row. Each kill
    // is bounded to 1s; allSettled means a slow daemon can't stall the
    // whole shutdown. The 5s shutdown hard cap is still the outer guard.
    const interruptedExecIds = await interruptActiveExecRuns("[moor shutting down; exec killed]");
    clearAllSessions();
    if (interruptedProjectIds.length > 0) {
      console.log(`[moor] interrupted ${interruptedProjectIds.length} in-flight build/pull`);
    }
    if (interruptedExecIds.length > 0) {
      // "interrupted" not "killed": some rows may have landed on 'error' if
      // killExec couldn't verify a clean termination. The rows themselves
      // carry the per-run truth (state + stderr + error_message).
      console.log(`[moor] interrupted ${interruptedExecIds.length} in-flight async exec`);
    }

    // Reconcile projects.status for each interrupted build so the
    // recorded status doesn't stay 'building' / 'pulling' across
    // restart. Each call does a fresh Docker inspect (short timeout)
    // and updates the row. Bounded by the 5s shutdown hard cap.
    const reconciledIds = new Set(interruptedProjectIds);
    await Promise.allSettled(
      interruptedTargets
        .filter((t) => reconciledIds.has(t.projectId))
        .map((t) => reconcileProjectStatusAfterInterrupt(t.projectId, t.containerId)),
    );

    // Brief tick so the fetch aborts settle before exit. The kernel
    // closes sockets on exit anyway, but the explicit yield keeps the
    // daemon-side teardown ordering deterministic.
    await new Promise((r) => setTimeout(r, 250));
  } finally {
    clearTimeout(hardExit);
    process.exit(0);
  }
};
process.on("SIGTERM", () => {
  void shutdown();
});
process.on("SIGINT", () => {
  void shutdown();
});

console.log(`Moor running at http://localhost:${server.port}`);
