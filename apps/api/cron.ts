import db from "./db";
import { execInContainer, killExec } from "./docker";
import { requireLiveContainer } from "./status-reconciler";

/** Exported so the /api/runs/:id/stop dispatch path (#68) and its
 *  tests can observe active cron runs without going through the
 *  full cron tick. stopCronRun() is the documented public API; this
 *  map is the underlying state. */
export const activeRuns = new Map<number, { controller: AbortController; execId: string }>();

type CronRow = {
  id: number;
  project_id: number;
  name: string;
  schedule: string;
  command: string;
  enabled: number;
};

type ProjectRow = {
  id: number;
  container_id: string | null;
  status: string;
};

function matchesCron(schedule: string, date: Date): boolean {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  const [minPat, hourPat, domPat, monPat, dowPat] = parts;
  const minute = date.getMinutes();
  const hour = date.getHours();
  const dom = date.getDate();
  const month = date.getMonth() + 1;
  const dow = date.getDay(); // 0=Sunday

  return (
    matchField(minPat, minute, 0, 59) &&
    matchField(hourPat, hour, 0, 23) &&
    matchField(domPat, dom, 1, 31) &&
    matchField(monPat, month, 1, 12) &&
    matchField(dowPat, dow, 0, 6)
  );
}

function matchField(pattern: string, value: number, _min: number, _max: number): boolean {
  if (pattern === "*") return true;

  for (const part of pattern.split(",")) {
    // Handle step: */5 or 1-10/2
    const [rangePart, stepStr] = part.split("/");
    const step = stepStr ? Number(stepStr) : 1;

    if (rangePart === "*") {
      if (value % step === 0) return true;
      continue;
    }

    // Handle range: 1-5
    if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-").map(Number);
      if (value >= a && value <= b && (value - a) % step === 0) return true;
      continue;
    }

    // Exact value
    if (Number(rangePart) === value) return true;
  }

  return false;
}

let tickRunning = false;

async function tick() {
  if (tickRunning) return;
  tickRunning = true;
  try {
    await tickInner();
  } finally {
    tickRunning = false;
  }
}

async function tickInner() {
  const now = new Date();
  const crons = db.query("SELECT * FROM crons WHERE enabled = 1").all() as CronRow[];

  for (const cron of crons) {
    if (!matchesCron(cron.schedule, now)) continue;

    const project = db
      .query("SELECT id, container_id, status FROM projects WHERE id = ?")
      .get(cron.project_id) as ProjectRow | null;
    if (!project) continue;

    // #73: fresh inspect, not cached project.status. Cached would
    // silently skip a scheduled job with no run record when stale;
    // that's the exact lying-about-runtime-truth pattern we just
    // fixed for moor_status. Skipping IS still a valid outcome
    // (container missing / not running / Docker unreachable), but
    // it should leave an observable run row, not vanish.
    const live = await requireLiveContainer(project);
    if (!live.ok) {
      const reason =
        live.reason === "not_running"
          ? `container is ${live.live_status}`
          : live.reason === "docker_error"
            ? `Docker unreachable: ${live.message}`
            : live.reason; // "no_container" | "missing"
      // Set started_at_ms / finished_at_ms / duration_ms too: moor_runs
      // orders by COALESCE(started_at_ms, 0) DESC, so a NULL would sort
      // this skip row alongside ancient pre-#65 rows instead of as
      // recent. The whole point of writing a skip row is observability.
      const nowMs = Date.now();
      db.query(
        `INSERT INTO runs (cron_id, project_id, started_at, started_at_ms,
                           finished_at, finished_at_ms, exit_code,
                           stderr, duration_ms)
         VALUES (?, ?, datetime('now'), ?, datetime('now'), ?, -1, ?, 0)`,
      ).run(cron.id, cron.project_id, nowMs, nowMs, `cron skipped: ${reason}`);
      console.log(`[cron] skipped cron=${cron.id} reason=${reason}`);
      continue;
    }

    // Run in background — don't block the tick
    runCron(cron, project.container_id as string);
  }
}

export async function runCron(cron: CronRow, containerId: string) {
  // #73: set started_at_ms and finished_at_ms so moor_runs' ms-precision
  // ordering (COALESCE(started_at_ms,0) DESC, id DESC) sorts cron runs
  // alongside build runs correctly, and so duration_ms is precise.
  // Same pattern as exec_runs (#45) and build runs (#65).
  const start = Date.now();
  const startedAt = new Date(start).toISOString();
  const run = db
    .query(
      `INSERT INTO runs (cron_id, project_id, started_at, started_at_ms)
       VALUES (?, ?, ?, ?) RETURNING id`,
    )
    .get(cron.id, cron.project_id, startedAt, start) as { id: number };

  const controller = new AbortController();
  const entry = { controller, execId: "" };
  activeRuns.set(run.id, entry);

  const finalize = (exitCode: number, stdout: string, stderr: string): void => {
    const finish = Date.now();
    db.query(
      `UPDATE runs SET finished_at = ?, finished_at_ms = ?, exit_code = ?,
                       stdout = ?, stderr = ?, duration_ms = ?
       WHERE id = ?`,
    ).run(new Date(finish).toISOString(), finish, exitCode, stdout, stderr, finish - start, run.id);
  };

  try {
    const result = await execInContainer(containerId, cron.command, {
      signal: controller.signal,
      onExecId: (id) => {
        entry.execId = id;
      },
    });
    finalize(result.exitCode, result.stdout, result.stderr);
  } catch (e) {
    if (controller.signal.aborted) {
      finalize(-1, "", "Stopped by user");
    } else {
      const message = e instanceof Error ? e.message : "Unknown error";
      finalize(-1, "", message);
    }
  } finally {
    activeRuns.delete(run.id);
  }
}

export async function stopCronRun(runId: number): Promise<boolean> {
  const active = activeRuns.get(runId);
  if (!active) return false;

  // Kill the process inside the container
  if (active.execId) {
    await killExec(active.execId);
  }

  // Abort the fetch (causes runCron to record "Stopped by user")
  active.controller.abort();
  return true;
}

export function startCronScheduler() {
  console.log("[cron] Scheduler started — checking every 60s");
  setInterval(tick, 60_000);
}

/** #77: mark all active cron runs as interrupted during graceful
 *  shutdown. Stderr message matches the convention used by
 *  interruptActiveBuildRuns ("[moor shutting down; ...]") so a post-
 *  restart inspector sees consistent terminal rows regardless of run
 *  type. WHERE finished_at IS NULL preserves any row that's already
 *  raced to its own terminal state. */
export function interruptActiveRuns() {
  const now = Date.now();
  for (const [runId, active] of activeRuns) {
    active.controller.abort();
    db.query(
      `UPDATE runs SET finished_at = ?, finished_at_ms = ?, exit_code = -1, stderr = ?
       WHERE id = ? AND finished_at IS NULL`,
    ).run(new Date(now).toISOString(), now, "[moor shutting down; cron run aborted]", runId);
  }
  activeRuns.clear();
}
