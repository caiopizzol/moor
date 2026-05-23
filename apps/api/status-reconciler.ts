// #71: background status reconciler. Walks every project with a
// container_id, asks Docker for its current State, and writes the
// result into the live_* columns. projects.status is NEVER mutated
// here — it remains moor's recorded action state. The drift between
// recorded and live is itself diagnostic signal ("moor missed an
// event") that callers should see, not silently erase.
//
// Infrastructure-failure handling is load-bearing: if the inspect
// call throws (socket unreachable, 5xx, JSON parse failure), the
// last successful live_status / live_exit_code are preserved and
// live_error is set. A periodic loop must not rewrite truth from a
// transient daemon glitch — that would cause false alerts on every
// Docker daemon restart or network blip.

import db from "./db";
import { SOCKET as SOCKET_PATH } from "./docker";

const INTERVAL_MS = 30_000;

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let cycleRunning = false;

export type LiveStatus = "running" | "stopped" | "error" | "missing";

export type ContainerState = {
  Running: boolean;
  ExitCode?: number;
  OOMKilled?: boolean;
};

/** Pure: map a Docker container State to live_status / live_exit_code.
 *  "missing" is handled at the inspect level (404), not by this parser. */
export function parseContainerState(state: ContainerState): {
  live_status: Exclude<LiveStatus, "missing">;
  live_exit_code: number | null;
} {
  if (state.Running) {
    return { live_status: "running", live_exit_code: null };
  }
  const exitCode = state.ExitCode ?? 0;
  if (exitCode === 0 && !state.OOMKilled) {
    return { live_status: "stopped", live_exit_code: 0 };
  }
  return { live_status: "error", live_exit_code: exitCode };
}

/** Inspector return type. The reconciler treats each variant
 *  deterministically; failures preserve the previous live_* values
 *  while ok-states overwrite them. */
export type InspectResult =
  | { ok: true; state: ContainerState }
  | { ok: false; kind: "missing" }
  | { ok: false; kind: "error"; message: string };

export type Inspector = (containerId: string) => Promise<InspectResult>;

/** Real Docker inspector. Treats 404 as `missing` and any other
 *  non-OK status or thrown error as `error` (with a message). */
export const realInspect: Inspector = async (containerId: string) => {
  try {
    const res = await fetch(
      `http://localhost/v1.44/containers/${encodeURIComponent(containerId)}/json`,
      { unix: SOCKET_PATH, signal: AbortSignal.timeout(5000) },
    );
    if (res.status === 404) return { ok: false, kind: "missing" };
    if (!res.ok) {
      return { ok: false, kind: "error", message: `inspect ${res.status}` };
    }
    const data = (await res.json()) as { State: ContainerState };
    return { ok: true, state: data.State };
  } catch (e) {
    return {
      ok: false,
      kind: "error",
      message: e instanceof Error ? e.message : String(e),
    };
  }
};

function writeLiveOk(projectId: number, liveStatus: LiveStatus, liveExitCode: number | null): void {
  db.query(
    `UPDATE projects
     SET live_status = ?, live_exit_code = ?, live_checked_at = datetime('now'), live_error = NULL
     WHERE id = ?`,
  ).run(liveStatus, liveExitCode, projectId);
}

function writeLiveError(projectId: number, message: string): void {
  // Only live_error changes; live_status, live_exit_code, AND
  // live_checked_at keep their last successful values. The MCP
  // description guarantees live_checked_at is the time of the last
  // successful inspect — moving it forward on a failure would lie
  // ("we checked 2 seconds ago and it's running") when really we
  // tried 2 seconds ago, failed, and the "running" is from earlier.
  // The next successful inspect updates live_checked_at and clears
  // live_error in writeLiveOk.
  db.query("UPDATE projects SET live_error = ? WHERE id = ?").run(message, projectId);
}

/** One reconciler pass. Walks every project with container_id IS NOT
 *  NULL. Skips if a previous cycle is still in flight (single-flight
 *  guard) — same pattern as #59 cleanup scheduler. Inspector defaults
 *  to realInspect; tests inject a mock. */
export async function reconcileOnce(inspect: Inspector = realInspect): Promise<void> {
  if (cycleRunning) {
    console.log("[status-reconciler] previous cycle still running; skipping this tick");
    return;
  }
  cycleRunning = true;
  try {
    const rows = db
      .query("SELECT id, container_id FROM projects WHERE container_id IS NOT NULL")
      .all() as Array<{ id: number; container_id: string }>;

    for (const row of rows) {
      const result = await inspect(row.container_id);
      if (!result.ok) {
        if (result.kind === "missing") {
          writeLiveOk(row.id, "missing", null);
        } else {
          writeLiveError(row.id, result.message);
        }
        continue;
      }
      const parsed = parseContainerState(result.state);
      writeLiveOk(row.id, parsed.live_status, parsed.live_exit_code);
    }
  } finally {
    cycleRunning = false;
  }
}

export function startStatusReconciler(): void {
  console.log(`[status-reconciler] enabled: live status sync every ${INTERVAL_MS / 1000}s`);
  intervalHandle = setInterval(() => {
    void reconcileOnce();
  }, INTERVAL_MS);
}

export function stopStatusReconciler(): void {
  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

/** #73: action-path gate. Routes that are about to execute against
 *  the container (exec, terminal upgrade, cron run — manual AND tick)
 *  should call this BEFORE acting. Cached live_status from the 30s
 *  reconciler loop is appropriate for display, but actions need
 *  current truth — a stale "running" snapshot can approve an exec
 *  against a dead container.
 *
 *  Also explicitly distinguishes "Docker unreachable" (docker_error,
 *  caller should return 503) from "container not running" (the
 *  current code can't tell those apart and rejects everything
 *  identically with 400). Surfacing the difference matters for
 *  operator debugging — "my exec failed" vs "moor can't reach
 *  Docker" are very different problems.
 *
 *  Opportunistically writes the live_* columns from the fresh
 *  inspect; the next reconciler tick would have done it anyway and
 *  we already have the response. Never mutates projects.status —
 *  preserves the #71 dual-field semantic.
 *
 *  Inspector is injectable for tests; production uses realInspect. */
export type LiveRequireResult =
  | { ok: true }
  | { ok: false; reason: "no_container" }
  | { ok: false; reason: "not_running"; live_status: Exclude<LiveStatus, "missing"> }
  | { ok: false; reason: "missing" }
  | { ok: false; reason: "docker_error"; message: string };

export async function requireLiveContainer(
  project: { id: number; container_id: string | null },
  inspect: Inspector = realInspect,
): Promise<LiveRequireResult> {
  if (!project.container_id) {
    return { ok: false, reason: "no_container" };
  }
  const result = await inspect(project.container_id);
  if (!result.ok) {
    if (result.kind === "missing") {
      writeLiveOk(project.id, "missing", null);
      return { ok: false, reason: "missing" };
    }
    writeLiveError(project.id, result.message);
    return { ok: false, reason: "docker_error", message: result.message };
  }
  const parsed = parseContainerState(result.state);
  writeLiveOk(project.id, parsed.live_status, parsed.live_exit_code);
  if (parsed.live_status === "running") return { ok: true };
  return { ok: false, reason: "not_running", live_status: parsed.live_status };
}

/** Convert a LiveRequireResult into the HTTP response a route should
 *  send when ok is false. Returns null when ok (caller proceeds).
 *  Centralized so every action route uses the same status codes and
 *  body shape — 400 for "no container yet" (user error: build first),
 *  409 for "wrong state" (project conflict, body carries the live
 *  status), 503 for Docker unreachable (infrastructure failure, not
 *  the project's fault). */
export function liveRequireErrorResponse(result: LiveRequireResult): Response | null {
  if (result.ok) return null;
  switch (result.reason) {
    case "no_container":
      return new Response("Project has no container; build/start it first", { status: 400 });
    case "missing":
      return Response.json(
        { error: "Container record is stale (Docker has no such container)", reason: "missing" },
        { status: 409 },
      );
    case "not_running":
      return Response.json(
        {
          error: "Container is not running",
          reason: "not_running",
          live_status: result.live_status,
        },
        { status: 409 },
      );
    case "docker_error":
      return Response.json(
        { error: "Docker unreachable", reason: "docker_error", message: result.message },
        { status: 503 },
      );
  }
}
