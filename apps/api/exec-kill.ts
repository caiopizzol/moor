// #34 Phase A.5: best-effort kill of a running exec via a sidecar exec into the
// same container. The old killExec called process.kill on the Docker-reported
// host PID, which never worked from inside moor's container (no shared PID
// namespace) — the timeout returned to the caller while the workload kept
// running and mutating state. The fix is to capture the container-local PID at
// the start of every exec (via a tiny shell wrapper that writes $$ to /tmp)
// and, on cancel, run a sidecar exec that walks the descendant tree from that
// PID and sends signals to each.

// Grace period between SIGTERM and SIGKILL, matching common docker stop semantics.
export const EXEC_KILL_GRACE_S = 1;

/** Build the Docker exec Cmd array that wraps a user command with PID capture.
 *  Uses positional arguments to avoid shell quoting issues — the user's command
 *  is passed verbatim as $3 and never interpolated into a shell string. */
export function buildWrappedExecCmd(command: string, pidFile: string): string[] {
  return [
    "sh",
    "-c",
    `echo $$ > ${pidFile} 2>/dev/null; exec "$@"`,
    // $0 is a script-name placeholder; positional args start at $1.
    "moor-exec",
    "sh",
    "-c",
    command,
  ];
}

/** Build the kill script run via a sidecar exec into the same container.
 *
 *  Walks /proc to enumerate the full descendant tree of the recorded PID by
 *  following PPid links, sends SIGTERM to each PID, waits a grace period,
 *  then SIGKILL. Verifies by re-reading /proc/PID/status and counting
 *  processes in a live (non-zombie) state. Zombies (state Z or X) are
 *  excluded because many container PID 1s never `wait()`, so an unreaped
 *  zombie can linger indefinitely without being a real running process.
 *
 *  Per-PID positive-integer kills are used instead of `kill -PG` because
 *  Docker exec doesn't guarantee the wrapper sh is a process-group leader,
 *  and `kill -- -PID` syntax isn't portable across busybox / util-linux.
 *
 *  Snapshot limit: the tree is collected ONCE before the kill phase. If a
 *  process in the tree forks a new child AFTER the scan but BEFORE the grace
 *  period elapses, that child escapes — its PID was never in `all` so it
 *  never receives a signal. The verify step only counts PIDs from `all`, so
 *  this escape is not visible in `live`. Acceptable for the stated contract:
 *  we honestly report what happened to the processes we found. */
export function buildKillScript(pidFile: string, graceSeconds = EXEC_KILL_GRACE_S): string {
  const lines = [
    `pid=$(cat ${pidFile} 2>/dev/null)`,
    'if [ -z "$pid" ]; then echo "no-pid"; exit 0; fi',
    'all="$pid"',
    'frontier="$pid"',
    'while [ -n "$frontier" ]; do',
    '  next=""',
    "  for parent in $frontier; do",
    "    for d in /proc/[0-9]*; do",
    "      cpid=${d#/proc/}",
    '      case " $all " in *" $cpid "*) continue;; esac',
    "      ppid=$(awk '/^PPid:/{print $2}' \"$d/status\" 2>/dev/null)",
    '      if [ "$ppid" = "$parent" ]; then',
    '        all="$all $cpid"',
    '        next="$next $cpid"',
    "      fi",
    "    done",
    "  done",
    '  frontier="$next"',
    "done",
    'for p in $all; do kill -TERM "$p" 2>/dev/null; done',
    `sleep ${graceSeconds}`,
    'for p in $all; do kill -KILL "$p" 2>/dev/null; done',
    "sleep 0.2",
    "live=0",
    "for p in $all; do",
    '  [ -d "/proc/$p" ] || continue',
    "  st=$(awk '/^State:/{print $2}' \"/proc/$p/status\" 2>/dev/null)",
    '  case "$st" in',
    '    Z|X|"") ;;',
    "    *) live=$((live+1));;",
    "  esac",
    "done",
    `rm -f ${pidFile}`,
    'echo "kill-sent-$pid;live=$live"',
  ];
  return lines.join("\n");
}

/** Parse the kill script's stdout. `sentTo` is the recorded PID we attempted
 *  to kill (null when no pidfile existed). `live` is the count of descendants
 *  that were still in a non-zombie state after the SIGKILL — anything > 0
 *  means the kill did not fully take effect. */
export function parseKillResult(stdout: string): { sentTo: string | null; live: number } {
  const trimmed = stdout.trim();
  if (trimmed === "no-pid" || trimmed === "") return { sentTo: null, live: 0 };
  const m = trimmed.match(/^kill-sent-(\d+);live=(\d+)$/);
  if (!m) return { sentTo: null, live: 0 };
  return { sentTo: m[1], live: Number.parseInt(m[2], 10) };
}
