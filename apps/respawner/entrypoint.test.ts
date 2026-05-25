// Tests for the respawner entrypoint.sh apply mode. Stubs `docker` and
// `curl` in a per-test PATH so the script exercises pull / up / health
// / rollback paths without real Docker.
//
// What we're checking:
//   - Marker shapes for every terminal state (failed / rolled_back /
//     rollback_failed / success).
//   - State machine: pull failure → failed, NO rollback.
//   - up/wait failure → rollback attempted.
//   - up failure → rollback up failure → rollback_failed (carries
//     BOTH apply error AND rollback error).
//   - health failure → rollback attempted (similar shape).
//   - prev_image_id missing/invalid → falls back to `failed` with
//     a "cannot rollback" suffix.
//   - rollback override file is written atomically (no .tmp left).

import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "entrypoint.sh");
const TEST_ROOT = mkdtempSync(join(tmpdir(), "respawner-script-test-"));

afterAll(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

type StubBehavior = {
  // The shell body to drop into the stub. Has access to "$@".
  docker?: string;
  curl?: string;
};

function newTestDir(): string {
  const d = mkdtempSync(join(TEST_ROOT, "case-"));
  return d;
}

function writeStubs(stubsDir: string, b: StubBehavior): void {
  // The default `docker` stub is a multiplexer that lets each test
  // override only the subcommands it cares about. Defaults log to
  // stdout and exit 0 so the script can introspect what was called.
  const dockerBody =
    b.docker ??
    `case "$1" in
  version) exit 0 ;;
  compose)
    shift
    # parse out the final positional (service name) by walking args.
    last=""
    for a in "$@"; do last="$a"; done
    echo "[stub-docker-compose] $@"
    exit 0
    ;;
  tag) exit 0 ;;
  *) exit 0 ;;
esac`;
  const curlBody = b.curl ?? `exit 0`;

  writeFileSync(join(stubsDir, "docker"), `#!/bin/sh\n${dockerBody}\n`);
  chmodSync(join(stubsDir, "docker"), 0o755);
  writeFileSync(join(stubsDir, "curl"), `#!/bin/sh\n${curlBody}\n`);
  chmodSync(join(stubsDir, "curl"), 0o755);
}

function writeContext(
  dataDir: string,
  auditId: number,
  overrides: Partial<{
    service: string;
    working_dir: string;
    target_digest: string;
    prev_image_id: string | null;
    config_files: string[];
  }> = {},
): void {
  const ctx = {
    audit_id: auditId,
    target_digest: overrides.target_digest ?? `sha256:${"a".repeat(64)}`,
    // `??` falls back on null, which silently masks a deliberate null;
    // use the property-existence check so tests can assert null/empty.
    prev_image_id:
      "prev_image_id" in overrides ? overrides.prev_image_id : `sha256:${"b".repeat(64)}`,
    service: overrides.service ?? "moor",
    working_dir: overrides.working_dir ?? "/root/moor",
    config_files: overrides.config_files ?? ["/root/moor/docker-compose.yml"],
    data_mount: {
      type: "volume" as const,
      name: "moor_moor-data",
      source: "/var/lib/docker/volumes/moor_moor-data/_data",
      destination: "/app/data",
    },
    network: "moor_default",
  };
  writeFileSync(join(dataDir, `.update-context-${auditId}.json`), JSON.stringify(ctx, null, 2));
  writeFileSync(
    join(dataDir, `.update-override-${auditId}.yml`),
    `services:\n  ${ctx.service}:\n    image: ghcr.io/caiopizzol/moor@${ctx.target_digest}\n`,
  );
}

async function runApply(opts: {
  dataDir: string;
  stubsDir: string;
  auditId: number;
  shrinkTimeouts?: boolean;
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  // Make health timeout short so health-fail tests don't take 60s.
  const preamble = opts.shrinkTimeouts
    ? "export HEALTH_TIMEOUT_SECONDS=2 HEALTH_INTERVAL_SECONDS=1 WAIT_TIMEOUT_SECONDS=2 START_DELAY_SECONDS=0\n"
    : "export START_DELAY_SECONDS=0\n";
  // Bash isn't in the alpine respawner; we test against /bin/sh.
  const proc = Bun.spawn(["/bin/sh", "-c", `${preamble}exec '${SCRIPT}' apply`], {
    env: {
      ...process.env,
      PATH: `${opts.stubsDir}:${process.env.PATH ?? ""}`,
      MOOR_AUDIT_ID: String(opts.auditId),
      MOOR_DATA_DIR: opts.dataDir,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
}

function readMarker(
  dataDir: string,
  auditId: number,
): {
  audit_id: number;
  state: string;
  error_log?: string;
  rollback_error?: string;
} {
  const p = join(dataDir, `.update-result-${auditId}.json`);
  return JSON.parse(readFileSync(p, "utf-8"));
}

function listJunk(dataDir: string): string[] {
  return readdirSync(dataDir).filter((n) => n.includes(".tmp."));
}

describe("respawner entrypoint apply: pull failure", () => {
  test("pull failure → marker 'failed', NO rollback attempted", async () => {
    const dir = newTestDir();
    const stubs = newTestDir();
    writeContext(dir, 1);
    // docker compose pull returns 1 with a message; docker tag MUST
    // NOT be invoked (we'd notice because we'd see the rollback
    // override file).
    writeStubs(stubs, {
      docker: `case "$1" in
  version) exit 0 ;;
  compose)
    # second positional after 'compose' may be -f flags; scan for "pull"
    for a in "$@"; do
      if [ "$a" = "pull" ]; then
        echo "Error response from daemon: manifest unknown" >&2
        exit 1
      fi
      if [ "$a" = "up" ]; then
        echo "[stub] unexpected: up reached after pull failure" >&2
        exit 99
      fi
    done
    exit 0
    ;;
  tag)
    echo "[stub] unexpected: docker tag reached after pull failure" >&2
    exit 99
    ;;
  *) exit 0 ;;
esac`,
    });
    const r = await runApply({ dataDir: dir, stubsDir: stubs, auditId: 1, shrinkTimeouts: true });
    expect(r.exitCode).toBe(1);

    const marker = readMarker(dir, 1);
    expect(marker.state).toBe("failed");
    expect(marker.error_log).toContain("compose pull failed");
    expect(marker.error_log).toContain("manifest unknown");
    expect(marker.rollback_error).toBeUndefined();

    // No rollback override file written.
    expect(existsSync(join(dir, ".update-rollback-1.yml"))).toBe(false);
    expect(listJunk(dir)).toEqual([]);
  });
});

describe("respawner entrypoint apply: up failure → rollback", () => {
  test("up fails → rollback succeeds → marker 'rolled_back' with original error preserved", async () => {
    const dir = newTestDir();
    const stubs = newTestDir();
    writeContext(dir, 2);
    // pull ok, up fails, rollback up (--pull never) succeeds.
    writeStubs(stubs, {
      docker: `case "$1" in
  version) exit 0 ;;
  compose)
    # Look for the verb.
    verb=""
    pull_never=0
    for a in "$@"; do
      case "$a" in
        pull|up|version) verb="$a" ;;
        --pull) pull_never=mark ;;
        never)
          if [ "$pull_never" = "mark" ]; then pull_never=1; fi
          ;;
      esac
    done
    case "$verb" in
      pull) exit 0 ;;
      up)
        if [ "$pull_never" = "1" ]; then
          # rollback compose up — succeed
          exit 0
        fi
        # apply compose up — fail with a clear message
        echo "Error response from daemon: image manifest mismatch" >&2
        exit 1
        ;;
    esac
    exit 0
    ;;
  tag) exit 0 ;;
  *) exit 0 ;;
esac`,
      // health passes on first try (for the rollback poll).
      curl: `exit 0`,
    });
    const r = await runApply({ dataDir: dir, stubsDir: stubs, auditId: 2, shrinkTimeouts: true });
    expect(r.exitCode).toBe(0);

    const marker = readMarker(dir, 2);
    expect(marker.state).toBe("rolled_back");
    expect(marker.error_log).toContain("compose up failed");
    expect(marker.error_log).toContain("manifest mismatch");
    expect(marker.rollback_error).toBeUndefined();

    // Rollback override file was written.
    const rb = readFileSync(join(dir, ".update-rollback-2.yml"), "utf-8");
    expect(rb).toContain("image: ghcr.io/caiopizzol/moor:latest");
    expect(rb).toContain("moor:");
    expect(listJunk(dir)).toEqual([]);
  });
});

describe("respawner entrypoint apply: up failure → rollback also fails", () => {
  test("up fails AND rollback up fails → marker 'rollback_failed' with BOTH errors", async () => {
    const dir = newTestDir();
    const stubs = newTestDir();
    writeContext(dir, 3);
    writeStubs(stubs, {
      docker: `case "$1" in
  version) exit 0 ;;
  compose)
    verb=""
    pull_never=0
    for a in "$@"; do
      case "$a" in
        pull|up|version) verb="$a" ;;
        --pull) pull_never=mark ;;
        never)
          if [ "$pull_never" = "mark" ]; then pull_never=1; fi
          ;;
      esac
    done
    case "$verb" in
      pull) exit 0 ;;
      up)
        if [ "$pull_never" = "1" ]; then
          echo "Error response from daemon: latest tag not found locally" >&2
          exit 1
        fi
        echo "Error response from daemon: original up failure" >&2
        exit 1
        ;;
    esac
    exit 0
    ;;
  tag) exit 0 ;;
  *) exit 0 ;;
esac`,
    });
    const r = await runApply({ dataDir: dir, stubsDir: stubs, auditId: 3, shrinkTimeouts: true });
    expect(r.exitCode).toBe(1);

    const marker = readMarker(dir, 3);
    expect(marker.state).toBe("rollback_failed");
    expect(marker.error_log).toContain("original up failure");
    expect(marker.rollback_error).toContain("rollback compose up failed");
    expect(marker.rollback_error).toContain("latest tag not found");
  });
});

describe("respawner entrypoint apply: health failure → rollback", () => {
  // Combined apply + rollback polling is ~4s real time even with the
  // shrunk timeouts; bump per-test timeout so slow CI doesn't flake.
  test("up succeeds but health never passes → rollback succeeds → marker 'rolled_back'", async () => {
    const dir = newTestDir();
    const stubs = newTestDir();
    writeContext(dir, 4);
    // Health curl returns 1 (failing) for apply, but the rollback
    // poll should also see it failing... wait — both polls use the
    // same curl stub. To make rollback's health pass we need to
    // count invocations. Use a counter file.
    const counter = join(dir, ".curl-count");
    writeFileSync(counter, "0");
    writeStubs(stubs, {
      docker: `case "$1" in
  version) exit 0 ;;
  compose) exit 0 ;;
  tag) exit 0 ;;
  *) exit 0 ;;
esac`,
      // First N curl calls fail (apply health window), then succeed
      // (rollback health). The apply window with HEALTH_TIMEOUT=2,
      // INTERVAL=1 → 2 attempts; rollback gets attempts after that.
      curl: `n=$(cat ${counter} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${counter}
if [ $n -le 3 ]; then exit 22; fi
exit 0`,
    });
    const r = await runApply({ dataDir: dir, stubsDir: stubs, auditId: 4, shrinkTimeouts: true });
    expect(r.exitCode).toBe(0);

    const marker = readMarker(dir, 4);
    expect(marker.state).toBe("rolled_back");
    expect(marker.error_log).toContain("health check did not pass");
    expect(marker.rollback_error).toBeUndefined();
  }, 15_000);
});

describe("respawner entrypoint apply: prev_image_id missing or invalid", () => {
  test("up fails AND prev_image_id is empty → marker 'failed' (cannot rollback to nothing)", async () => {
    const dir = newTestDir();
    const stubs = newTestDir();
    writeContext(dir, 5, { prev_image_id: null });
    writeStubs(stubs, {
      docker: `case "$1" in
  version) exit 0 ;;
  compose)
    verb=""
    for a in "$@"; do
      case "$a" in pull|up|version) verb="$a" ;; esac
    done
    case "$verb" in
      pull) exit 0 ;;
      up)
        echo "up failure" >&2
        exit 1
        ;;
    esac
    exit 0
    ;;
  tag)
    echo "[stub] unexpected: docker tag with no prev_image_id" >&2
    exit 99
    ;;
  *) exit 0 ;;
esac`,
    });
    const r = await runApply({ dataDir: dir, stubsDir: stubs, auditId: 5, shrinkTimeouts: true });
    expect(r.exitCode).toBe(1);

    const marker = readMarker(dir, 5);
    expect(marker.state).toBe("failed");
    expect(marker.error_log).toContain("cannot rollback");
    expect(marker.error_log).toContain("up failure");
    expect(marker.rollback_error).toBeUndefined();
  });

  test("up fails AND prev_image_id is malformed (no sha256: prefix) → marker 'failed'", async () => {
    const dir = newTestDir();
    const stubs = newTestDir();
    writeContext(dir, 6, { prev_image_id: "garbage" });
    writeStubs(stubs, {
      docker: `case "$1" in
  version) exit 0 ;;
  compose)
    verb=""
    for a in "$@"; do case "$a" in pull|up) verb="$a" ;; esac; done
    case "$verb" in
      pull) exit 0 ;;
      up) echo up-fail >&2; exit 1 ;;
    esac
    exit 0
    ;;
  *) exit 0 ;;
esac`,
    });
    const r = await runApply({ dataDir: dir, stubsDir: stubs, auditId: 6, shrinkTimeouts: true });
    expect(r.exitCode).toBe(1);
    const marker = readMarker(dir, 6);
    expect(marker.state).toBe("failed");
    expect(marker.error_log).toContain("cannot rollback");
    expect(marker.error_log).toContain("garbage");
  });
});

describe("respawner entrypoint apply: happy path success", () => {
  test("pull + up + health all pass → marker 'success', no rollback artifacts", async () => {
    const dir = newTestDir();
    const stubs = newTestDir();
    writeContext(dir, 7);
    writeStubs(stubs, { curl: `exit 0` });
    const r = await runApply({ dataDir: dir, stubsDir: stubs, auditId: 7, shrinkTimeouts: true });
    expect(r.exitCode).toBe(0);

    const marker = readMarker(dir, 7);
    expect(marker.state).toBe("success");
    expect(marker.error_log).toBeUndefined();
    expect(marker.rollback_error).toBeUndefined();

    // No rollback override file written on success.
    expect(existsSync(join(dir, ".update-rollback-7.yml"))).toBe(false);
    expect(listJunk(dir)).toEqual([]);
  });
});

describe("respawner entrypoint apply: tag failure during rollback", () => {
  test("docker tag fails → marker 'rollback_failed' with tag error in rollback_error", async () => {
    const dir = newTestDir();
    const stubs = newTestDir();
    writeContext(dir, 8);
    writeStubs(stubs, {
      docker: `case "$1" in
  version) exit 0 ;;
  compose)
    verb=""
    for a in "$@"; do case "$a" in pull|up) verb="$a" ;; esac; done
    case "$verb" in
      pull) exit 0 ;;
      up) echo up-fail >&2; exit 1 ;;
    esac
    exit 0
    ;;
  tag)
    echo "Error: no such image" >&2
    exit 1
    ;;
  *) exit 0 ;;
esac`,
    });
    const r = await runApply({ dataDir: dir, stubsDir: stubs, auditId: 8, shrinkTimeouts: true });
    expect(r.exitCode).toBe(1);
    const marker = readMarker(dir, 8);
    expect(marker.state).toBe("rollback_failed");
    expect(marker.error_log).toContain("up-fail");
    expect(marker.rollback_error).toContain("docker tag failed");
    expect(marker.rollback_error).toContain("no such image");
  });
});
