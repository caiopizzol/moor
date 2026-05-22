import { describe, expect, test } from "bun:test";
import { buildKillScript, buildWrappedExecCmd, parseKillResult } from "./exec-kill";

describe("buildWrappedExecCmd", () => {
  test("passes the user command via $@ instead of interpolating", () => {
    const cmd = buildWrappedExecCmd("echo hi", "/tmp/.moor-exec-X.pid");
    // The user's command is in the positional-args tail, not in the wrapper string.
    expect(cmd).toEqual([
      "sh",
      "-c",
      'echo $$ > /tmp/.moor-exec-X.pid 2>/dev/null; exec "$@"',
      "moor-exec",
      "sh",
      "-c",
      "echo hi",
    ]);
  });

  test("does not require shell-escaping a user command containing quotes and semicolons", () => {
    const evil = `printf '%s\n' "hello; rm -rf /"; whoami`;
    const cmd = buildWrappedExecCmd(evil, "/tmp/.moor-exec-Y.pid");
    // The dangerous-looking command lands as a positional arg verbatim and
    // never goes through string concatenation into the wrapper script.
    expect(cmd[cmd.length - 1]).toBe(evil);
  });
});

describe("buildKillScript", () => {
  test("walks /proc for descendants instead of relying on kill -PG", () => {
    const s = buildKillScript("/tmp/.moor-exec-Z.pid", 2);
    // Tree walk via PPid lookups in /proc/PID/status
    expect(s).toContain("/proc/[0-9]*");
    expect(s).toContain("^PPid:");
    // Per-PID kill, not kill -PG (which isn't portable across kill impls)
    expect(s).toContain('kill -TERM "$p"');
    expect(s).toContain('kill -KILL "$p"');
    expect(s).toContain("sleep 2");
    // Survivor check filters zombies (Z/X) so unreaped processes don't
    // falsely register as "kill failed"
    expect(s).toContain('Z|X|""');
    expect(s).toContain("live=$((live+1))");
    expect(s).toContain("rm -f /tmp/.moor-exec-Z.pid");
    expect(s).toContain('echo "kill-sent-$pid;live=$live"');
    expect(s).toContain('echo "no-pid"');
  });

  test("defaults grace to a small positive number", () => {
    const s = buildKillScript("/tmp/.moor-exec-Z.pid");
    expect(s).toMatch(/sleep \d+/);
  });
});

describe("parseKillResult", () => {
  test("returns null/0 when the script reported no pidfile", () => {
    expect(parseKillResult("no-pid\n")).toEqual({ sentTo: null, live: 0 });
  });

  test("returns null/0 on empty output", () => {
    expect(parseKillResult("")).toEqual({ sentTo: null, live: 0 });
  });

  test("returns the PID and live count when the script signalled it", () => {
    expect(parseKillResult("kill-sent-1234;live=0\n")).toEqual({ sentTo: "1234", live: 0 });
  });

  test("reports non-zero live count when descendants survived", () => {
    expect(parseKillResult("kill-sent-9999;live=2")).toEqual({ sentTo: "9999", live: 2 });
  });

  test("returns null/0 on unrecognized output", () => {
    expect(parseKillResult("kill-sent-9999")).toEqual({ sentTo: null, live: 0 });
  });
});
