// #34 Phase B: async exec orchestration. moor_exec_async returns immediately
// with a run_id; the actual command runs in a fire-and-forget async function
// that streams output into rolling tail buffers and flushes them to DB at
// terminal state. moor_exec_status reads from DB but overlays live tail
// buffers for in-flight runs so operators see progress without waiting for
// completion. moor_exec_stop calls killExec and finalizes based on the kill
// outcome.

import db from "./db";
import { execInContainerStreaming, killExec } from "./docker";
import { TAIL_CAP_BYTES, TailBuffer } from "./output-cap";

export const EXEC_ASYNC_TIMEOUT_DEFAULT_MS = 86_400_000; // 24h
export const EXEC_ASYNC_TIMEOUT_MIN_MS = 60_000;
export const EXEC_ASYNC_TIMEOUT_MAX_MS = 86_400_000;

type ActiveRun = {
  execId: string;
  abort: AbortController;
  stdout: TailBuffer;
  stderr: TailBuffer;
  startedAtMs: number;
};

const activeRuns = new Map<number, ActiveRun>();

/** Test-only seam (#82). Seeds an entry in the otherwise-private activeRuns
 *  map so interruptActiveExecRuns can be unit-tested without spinning up real
 *  Docker. Production code uses startAsyncExec; this is not for general use.
 *  Returns the AbortController so tests can assert it was aborted. */
export function _seedActiveExecRunForTest(runId: number, execId: string): AbortController {
  const abort = new AbortController();
  activeRuns.set(runId, {
    execId,
    abort,
    stdout: new TailBuffer(),
    stderr: new TailBuffer(),
    startedAtMs: Date.now(),
  });
  return abort;
}

/** Test-only seam (#82). True iff the run is still in the in-memory map.
 *  interruptActiveExecRuns deletes its entries on finalize, so the absence
 *  of a key after the call is the "we finalized it" assertion. */
export function _hasActiveExecRunForTest(runId: number): boolean {
  return activeRuns.has(runId);
}

export type RunState = "running" | "exited" | "stopped" | "timed_out" | "error";

type ExecRunRow = {
  id: number;
  project_id: number;
  command: string;
  state: RunState;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  stdout_total_bytes: number;
  stderr_total_bytes: number;
  timeout_ms: number;
  killed_pid: string | null;
  error_message: string | null;
  started_at: string;
  finished_at: string | null;
  started_at_ms: number | null;
  finished_at_ms: number | null;
};

export type RunStatus = ExecRunRow & { duration_ms: number };

/** Insert a new exec_runs row in `running` state, set up in-memory tracking,
 *  and kick off the streaming exec in the background. Returns immediately
 *  with the new run_id — the actual command may still be initializing. */
export function startAsyncExec(params: {
  projectId: number;
  containerId: string;
  command: string;
  timeoutMs: number;
}): { runId: number } {
  // #45: started_at_ms is set from Date.now() at insert time. The text
  // started_at column keeps SQLite's second-precision datetime('now') default
  // for human-readable display; duration_ms reads from _ms columns first.
  const startedAtMs = Date.now();
  const inserted = db
    .query(
      "INSERT INTO exec_runs (project_id, command, state, timeout_ms, started_at_ms) VALUES (?, ?, 'running', ?, ?) RETURNING id",
    )
    .get(params.projectId, params.command, params.timeoutMs, startedAtMs) as { id: number };
  const runId = inserted.id;

  const abort = new AbortController();
  const active: ActiveRun = {
    execId: "",
    abort,
    stdout: new TailBuffer(TAIL_CAP_BYTES),
    stderr: new TailBuffer(TAIL_CAP_BYTES),
    startedAtMs,
  };
  activeRuns.set(runId, active);

  // Safety timeout. On expiry, kill the exec; the running streaming call
  // will see abort and return. We then finalize based on the kill outcome:
  // clean kill -> timed_out; survivors or no handle -> error.
  //
  // abort.abort() runs BEFORE killExec for the same reason as in
  // stopAsyncExec (#43): if the kill terminates the user's exec before the
  // background task sees the abort signal, the streaming dockerFetch returns
  // naturally with exit_code=143, the background task races to tryFinalize
  // 'exited' and wins, and our timed_out finalize becomes a no-op. Aborting
  // first makes the streaming reader throw on the abort path; the background
  // task's guard skips finalize; the wrapper still runs in the container so
  // killExec terminates it; this timed_out finalize then has no contention.
  const safetyTimer = setTimeout(async () => {
    if (!activeRuns.has(runId)) return; // already finalized
    abort.abort();
    let killResult: { sentTo: string | null; live: number } = { sentTo: null, live: 0 };
    if (active.execId) {
      try {
        killResult = await killExec(active.execId);
      } catch (e) {
        console.warn(`[exec-async] kill on timeout failed for run ${runId}:`, e);
      }
    }
    if (killResult.sentTo !== null && killResult.live === 0) {
      tryFinalize(runId, "timed_out", null, killResult.sentTo, null);
    } else if (killResult.sentTo !== null && killResult.live > 0) {
      tryFinalize(
        runId,
        "error",
        null,
        killResult.sentTo,
        `safety timeout (${params.timeoutMs}ms) fired; kill attempted but ${killResult.live} descendant(s) remained; process state unknown`,
      );
    } else {
      tryFinalize(
        runId,
        "error",
        null,
        null,
        `safety timeout (${params.timeoutMs}ms) fired; could not locate process to kill`,
      );
    }
  }, params.timeoutMs);

  // Fire-and-forget the streaming exec.
  void (async () => {
    try {
      const { exitCode } = await execInContainerStreaming(
        params.containerId,
        params.command,
        {
          onStdout: (b) => active.stdout.appendBytes(b),
          onStderr: (b) => active.stderr.appendBytes(b),
        },
        {
          signal: abort.signal,
          onExecId: (id) => {
            active.execId = id;
          },
        },
      );
      // Natural completion. tryFinalize is idempotent against terminal state:
      // if a stop or safety-timer path got here first, the UPDATE WHERE state =
      // 'running' affects zero rows and we don't overwrite the truthful state.
      if (abort.signal.aborted) return;
      tryFinalize(runId, "exited", exitCode, null, null);
    } catch (e) {
      if (abort.signal.aborted) return;
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[exec-async] run ${runId} failed:`, message);
      tryFinalize(runId, "error", null, null, message);
    } finally {
      clearTimeout(safetyTimer);
    }
  })();

  return { runId };
}

/** Stop a running exec. Always transitions to a terminal state on its first
 *  call: `stopped` on clean kill, `error` on survivors or missing handle.
 *  Retry is NOT supported — the kill script removes the pidfile after every
 *  attempt, and surviving descendants may have been reparented away from the
 *  recorded PID. The honest outcome of "kill attempted, survivors remained"
 *  is `error`, not "try again". */
export async function stopAsyncExec(runId: number): Promise<{
  ok: boolean;
  state: RunState | "not_found" | "not_running";
  killed_pid: string | null;
  live_remaining: number;
  message: string;
}> {
  const row = db.query("SELECT state FROM exec_runs WHERE id = ?").get(runId) as {
    state: RunState;
  } | null;
  if (!row) {
    return {
      ok: false,
      state: "not_found",
      killed_pid: null,
      live_remaining: 0,
      message: `run ${runId} not found`,
    };
  }
  if (row.state !== "running") {
    return {
      ok: false,
      state: "not_running",
      killed_pid: null,
      live_remaining: 0,
      message: `run ${runId} is in state '${row.state}', not running`,
    };
  }

  const active = activeRuns.get(runId);
  if (!active) {
    // DB says running but no active handle — moor restart edge case (the
    // orphan sweep in db.ts should have caught this, but be defensive).
    tryFinalize(
      runId,
      "error",
      null,
      null,
      "process may still be running; no active kill handle (moor restart or internal bug)",
    );
    return finalizedResponse(runId, "no active kill handle for this run; marked as error");
  }

  if (!active.execId) {
    // Exec hasn't started yet. Abort the signal so the streaming call returns,
    // then finalize as error (we have nothing to kill but also nothing ran).
    active.abort.abort();
    tryFinalize(runId, "error", null, null, "stop called before exec had started");
    return finalizedResponse(runId, "exec had not started yet; marked as error");
  }

  // Abort the streaming exec BEFORE calling killExec so the background task
  // takes the abort branch (and skips its own finalize) instead of seeing the
  // Docker exec complete naturally with exit_code=143 and racing to finalize
  // as 'exited' before our 'stopped' transition lands. The wrapper process is
  // still running in the container at this point — killExec terminates it.
  active.abort.abort();
  const result = await killExec(active.execId);

  if (result.sentTo !== null && result.live === 0) {
    const won = tryFinalize(runId, "stopped", null, result.sentTo, null);
    if (won) {
      return {
        ok: true,
        state: "stopped",
        killed_pid: result.sentTo,
        live_remaining: 0,
        message: `Process tree terminated (container pid ${result.sentTo})`,
      };
    }
    // Natural exit or safety timeout finalized first; report the truth.
    return finalizedResponse(
      runId,
      `Kill signal sent (pid ${result.sentTo}, live=0) but the run had already entered a terminal state`,
    );
  }

  if (result.sentTo !== null && result.live > 0) {
    // Survivors. Not retry-safe: the kill script removes the pidfile after
    // every attempt, and reparented descendants are unreachable from the
    // original PID. Mark error with the survivor count; operators have to
    // investigate the container directly.
    tryFinalize(
      runId,
      "error",
      null,
      result.sentTo,
      `kill attempted on pid ${result.sentTo} but ${result.live} descendant(s) remained; process state unknown`,
    );
    const current = readState(runId);
    return {
      ok: false,
      state: current ?? "error",
      killed_pid: result.sentTo,
      live_remaining: result.live,
      message: `Kill attempted on pid ${result.sentTo} but ${result.live} descendant(s) still running; marked error (no retry — pidfile is gone)`,
    };
  }

  // sentTo === null: the active handle existed but killExec couldn't locate
  // the process (e.g. pidfile vanished). Mark as error — retry won't help.
  tryFinalize(
    runId,
    "error",
    null,
    null,
    "kill could not locate the process (no pidfile); container may need restart",
  );
  return finalizedResponse(runId, "kill could not locate the process; marked as error");
}

/** #82: shutdown-path interrupt. Symmetric to interruptActiveBuildRuns and
 *  cron's interruptActiveRuns, but exec is async + needs a Docker round-trip
 *  to actually kill the container-side process (`/exec/start` is a single
 *  attach point — closing our HTTP connection does NOT cancel the exec).
 *
 *  Per-exec kill is bounded by PER_KILL_TIMEOUT_MS so one slow Docker call
 *  can't burn the entire shutdown budget; Promise.allSettled means others
 *  proceed in parallel. If a kill times out the row still gets finalized
 *  honestly with the reason in stderr — orphan sweep on next boot is the
 *  fallback.
 *
 *  Returns the run IDs we transitioned to 'stopped' (won the race against
 *  natural completion / safety timer / operator stop). The WHERE state =
 *  'running' guard in tryFinalize is the race protection; this function
 *  just reports what it actually did.
 *
 *  killer is injectable so tests don't need real Docker. */
export type ExecKiller = (execId: string) => Promise<{ sentTo: string | null; live: number }>;

const PER_KILL_TIMEOUT_MS = 1000;

export async function interruptActiveExecRuns(
  reason: string,
  killer: ExecKiller = killExec,
): Promise<number[]> {
  const entries = [...activeRuns.entries()];
  if (entries.length === 0) return [];

  const reasonBytes = new TextEncoder().encode(`\n${reason}\n`);

  const results = await Promise.allSettled(
    entries.map(async ([runId, active]) => {
      // Abort first so the streaming reader returns via its abort branch
      // (same ordering rationale as stopAsyncExec); the background task's
      // own tryFinalize is then guarded by abort.signal.aborted and skips.
      active.abort.abort();

      // Append the reason to the live stderr tail BEFORE finalize so the
      // persisted row's stderr column carries why-it-stopped along with
      // whatever output the process produced.
      active.stderr.appendBytes(reasonBytes);

      if (active.execId) {
        try {
          await Promise.race([
            killer(active.execId),
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error(`kill timeout after ${PER_KILL_TIMEOUT_MS}ms`)),
                PER_KILL_TIMEOUT_MS,
              ),
            ),
          ]);
        } catch (e) {
          // Don't block the finalize on a slow / failed kill — orphan
          // sweep will catch any genuinely-still-running process on next
          // boot, and the row is honestly marked stopped either way.
          console.warn(`[exec-async] kill on shutdown failed for run ${runId}:`, e);
        }
      }

      const won = tryFinalize(runId, "stopped", null, null, null);
      return won ? runId : null;
    }),
  );

  const interrupted: number[] = [];
  for (const r of results) {
    if (r.status === "fulfilled" && r.value !== null) {
      interrupted.push(r.value);
    }
  }
  return interrupted;
}

/** Read a run's current state. For in-flight runs the in-memory tail buffers
 *  are more recent than the DB (which only gets the final flush on terminal
 *  state), so we overlay them onto the row. */
export function getRunStatus(runId: number): RunStatus | null {
  const row = db.query("SELECT * FROM exec_runs WHERE id = ?").get(runId) as ExecRunRow | null;
  if (!row) return null;

  const active = activeRuns.get(runId);
  if (active && row.state === "running") {
    return {
      ...row,
      stdout: active.stdout.tail,
      stderr: active.stderr.tail,
      stdout_total_bytes: active.stdout.totalBytes,
      stderr_total_bytes: active.stderr.totalBytes,
      duration_ms: Date.now() - active.startedAtMs,
    };
  }

  // Terminal state — DB row is the source of truth. Prefer the _ms columns
  // (written from Date.now() with true millisecond precision); fall back to
  // parsing the text columns for rows that pre-date the #45 migration.
  const startedMs =
    row.started_at_ms ?? (row.started_at ? new Date(`${row.started_at}Z`).getTime() : Date.now());
  const finishedMs =
    row.finished_at_ms ??
    (row.finished_at ? new Date(`${row.finished_at}Z`).getTime() : Date.now());
  return { ...row, duration_ms: finishedMs - startedMs };
}

/** Race-safe terminal transition. Three paths can call this for a single run
 *  (natural completion, safety timer, stop request); the first one to UPDATE
 *  WHERE state='running' wins. Returns true if this call took the row to
 *  terminal state, false if some other path got there first. Always deletes
 *  the activeRuns entry — the caller's intent was "this run is done from my
 *  perspective" even if the row was already finalized. */
function tryFinalize(
  runId: number,
  state: RunState,
  exitCode: number | null,
  killedPid: string | null,
  errorMessage: string | null,
): boolean {
  const active = activeRuns.get(runId);
  // #45: finished_at_ms is set from Date.now() so duration_ms is accurate to
  // the millisecond. finished_at (text) keeps datetime('now') for display.
  const finishedAtMs = Date.now();
  let result: { changes: number };
  if (active) {
    result = db
      .query(
        `UPDATE exec_runs
         SET state = ?, exit_code = ?, stdout = ?, stderr = ?,
             stdout_total_bytes = ?, stderr_total_bytes = ?,
             killed_pid = ?, error_message = ?,
             finished_at = datetime('now'), finished_at_ms = ?
         WHERE id = ? AND state = 'running'`,
      )
      .run(
        state,
        exitCode,
        active.stdout.tail,
        active.stderr.tail,
        active.stdout.totalBytes,
        active.stderr.totalBytes,
        killedPid,
        errorMessage,
        finishedAtMs,
        runId,
      );
    activeRuns.delete(runId);
  } else {
    result = db
      .query(
        `UPDATE exec_runs
         SET state = ?, exit_code = ?,
             killed_pid = ?, error_message = ?,
             finished_at = datetime('now'), finished_at_ms = ?
         WHERE id = ? AND state = 'running'`,
      )
      .run(state, exitCode, killedPid, errorMessage, finishedAtMs, runId);
  }
  return result.changes > 0;
}

function readState(runId: number): RunState | null {
  const row = db.query("SELECT state FROM exec_runs WHERE id = ?").get(runId) as {
    state: RunState;
  } | null;
  return row?.state ?? null;
}

/** Build a stop response that reads the current state from DB. Used when
 *  finalize was a no-op (some other path already finalized) or when the
 *  finalize succeeded with state=error — in both cases the caller should
 *  see the truthful terminal state. */
function finalizedResponse(
  runId: number,
  message: string,
): { ok: false; state: RunState; killed_pid: null; live_remaining: 0; message: string } {
  const state = readState(runId) ?? "error";
  return { ok: false, state, killed_pid: null, live_remaining: 0, message };
}
