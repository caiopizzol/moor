// Tests for the respawner entrypoint.sh apply mode. Stubs `docker` and
// `curl` in a per-test PATH so the script exercises pull / tag / up /
// health / rollback paths without real Docker.
//
// What we're checking:
//   - Marker shapes for every terminal state (failed / rolled_back /
//     rollback_failed / success).
//   - State machine: docker pull failure → failed, NO rollback.
//   - State machine: docker tag failure on apply → failed, NO rollback
//     (moor was never replaced).
//   - up/wait failure → rollback attempted.
//   - up failure → rollback up failure → rollback_failed (carries
//     BOTH apply error AND rollback error).
//   - health failure → rollback attempted (similar shape).
//   - prev_image_id missing/invalid → falls back to `failed` with
//     a "cannot rollback" suffix.
//   - #105 contract: neither apply nor rollback writes
//     .update-{override,rollback}-<id>.yml; neither path appends
//     `-f /app/data/...` to the compose -f stack.

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
  // Every docker invocation logs its full argv to $stubsDir/docker.log
  // so tests can assert the -f stack was actually built and passed.
  // (The previous build_compose_argv used `set --` inside a function,
  // which POSIX sh doesn't propagate to the caller — silently dropped
  // the -f stack. The log makes that class of bug impossible to hide.)
  const dockerBody =
    b.docker ??
    `case "$1" in
  version) exit 0 ;;
  compose)
    shift
    echo "[stub-docker-compose] $@"
    exit 0
    ;;
  tag) exit 0 ;;
  *) exit 0 ;;
esac`;
  const curlBody = b.curl ?? `exit 0`;

  const dockerLog = join(stubsDir, "docker.log");
  // Prepend an argv-log line BEFORE the stub body so even stubs that
  // exit early still record the call.
  const dockerWithLog = `echo "$@" >> "${dockerLog}"\n${dockerBody}`;
  writeFileSync(join(stubsDir, "docker"), `#!/bin/sh\n${dockerWithLog}\n`);
  chmodSync(join(stubsDir, "docker"), 0o755);
  writeFileSync(join(stubsDir, "curl"), `#!/bin/sh\n${curlBody}\n`);
  chmodSync(join(stubsDir, "curl"), 0o755);
}

function readDockerLog(stubsDir: string): string[] {
  const p = join(stubsDir, "docker.log");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8")
    .split("\n")
    .filter((s) => s.length > 0);
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
  // #105: no .update-override-<id>.yml is written. The respawner pulls
  // the target image by digest itself and retags :latest locally.
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

describe("respawner entrypoint apply: docker pull failure (#105)", () => {
  test("docker pull failure → marker 'failed', NO docker tag, NO compose up, NO rollback", async () => {
    const dir = newTestDir();
    const stubs = newTestDir();
    writeContext(dir, 1);
    // docker pull returns 1 with a message; docker tag and docker
    // compose MUST NOT be invoked (we assert via the docker.log).
    writeStubs(stubs, {
      docker: `case "$1" in
  version) exit 0 ;;
  pull)
    echo "Error response from daemon: manifest unknown" >&2
    exit 1
    ;;
  tag)
    echo "[stub] unexpected: docker tag reached after pull failure" >&2
    exit 99
    ;;
  compose)
    echo "[stub] unexpected: docker compose reached after pull failure" >&2
    exit 99
    ;;
  *) exit 0 ;;
esac`,
    });
    const r = await runApply({ dataDir: dir, stubsDir: stubs, auditId: 1, shrinkTimeouts: true });
    expect(r.exitCode).toBe(1);

    const marker = readMarker(dir, 1);
    expect(marker.state).toBe("failed");
    expect(marker.error_log).toContain("docker pull");
    expect(marker.error_log).toContain("manifest unknown");
    expect(marker.rollback_error).toBeUndefined();

    const calls = readDockerLog(stubs);
    expect(calls.some((l) => l.startsWith("tag "))).toBe(false);
    expect(calls.some((l) => l.startsWith("compose "))).toBe(false);

    // No rollback or override files written.
    expect(existsSync(join(dir, ".update-rollback-1.yml"))).toBe(false);
    expect(existsSync(join(dir, ".update-override-1.yml"))).toBe(false);
    expect(listJunk(dir)).toEqual([]);
  });
});

describe("respawner entrypoint apply: docker tag failure on apply (#105)", () => {
  test("docker pull ok but docker tag fails → marker 'failed', NO compose up, NO rollback", async () => {
    const dir = newTestDir();
    const stubs = newTestDir();
    writeContext(dir, 11);
    // docker tag on apply uses 'ghcr.io/caiopizzol/moor@sha256:...' as
    // source. Make ONLY that case fail (rollback would use 'sha256:...'
    // directly, but rollback should never be reached here anyway).
    writeStubs(stubs, {
      docker: `case "$1" in
  version) exit 0 ;;
  pull) exit 0 ;;
  tag)
    case "$2" in
      ghcr.io/caiopizzol/moor@*)
        echo "Error: no such image" >&2
        exit 1
        ;;
      *)
        echo "[stub] unexpected docker tag arg: $2" >&2
        exit 99
        ;;
    esac
    ;;
  compose)
    echo "[stub] unexpected: compose reached after tag failure" >&2
    exit 99
    ;;
  *) exit 0 ;;
esac`,
    });
    const r = await runApply({ dataDir: dir, stubsDir: stubs, auditId: 11, shrinkTimeouts: true });
    expect(r.exitCode).toBe(1);

    const marker = readMarker(dir, 11);
    expect(marker.state).toBe("failed");
    expect(marker.error_log).toContain("docker tag");
    expect(marker.error_log).toContain("no such image");
    expect(marker.rollback_error).toBeUndefined();

    const calls = readDockerLog(stubs);
    expect(calls.some((l) => l.startsWith("compose "))).toBe(false);
  });
});

describe("respawner entrypoint apply: up failure → rollback", () => {
  test("up fails → rollback succeeds → marker 'rolled_back' with original error preserved", async () => {
    const dir = newTestDir();
    const stubs = newTestDir();
    writeContext(dir, 2);
    // pull + tag ok. Both apply and rollback `compose up` now use the
    // same shape (--pull never, operator-only -f stack), so we can't
    // distinguish them by argv. Counter file: 1st up = apply (fail),
    // 2nd up = rollback (succeed).
    const upCounter = join(dir, ".up-count");
    writeFileSync(upCounter, "0");
    writeStubs(stubs, {
      docker: `case "$1" in
  version) exit 0 ;;
  pull) exit 0 ;;
  tag) exit 0 ;;
  compose)
    verb=""
    for a in "$@"; do
      case "$a" in pull|up|version) verb="$a" ;; esac
    done
    case "$verb" in
      up)
        n=$(cat ${upCounter} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${upCounter}
        if [ $n = 1 ]; then
          echo "Error response from daemon: image manifest mismatch" >&2
          exit 1
        fi
        exit 0
        ;;
    esac
    exit 0
    ;;
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

    // #105: no rollback override file is written anymore.
    expect(existsSync(join(dir, ".update-rollback-2.yml"))).toBe(false);
    expect(existsSync(join(dir, ".update-override-2.yml"))).toBe(false);
    expect(listJunk(dir)).toEqual([]);
  });
});

describe("respawner entrypoint apply: up failure → rollback also fails", () => {
  test("up fails AND rollback up fails → marker 'rollback_failed' with BOTH errors", async () => {
    const dir = newTestDir();
    const stubs = newTestDir();
    writeContext(dir, 3);
    // Counter distinguishes 1st up (apply) from 2nd up (rollback);
    // both have identical argv post-#105.
    const upCounter = join(dir, ".up-count");
    writeFileSync(upCounter, "0");
    writeStubs(stubs, {
      docker: `case "$1" in
  version) exit 0 ;;
  pull) exit 0 ;;
  tag) exit 0 ;;
  compose)
    verb=""
    for a in "$@"; do case "$a" in pull|up|version) verb="$a" ;; esac; done
    case "$verb" in
      up)
        n=$(cat ${upCounter} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${upCounter}
        if [ $n = 1 ]; then
          echo "Error response from daemon: original up failure" >&2
          exit 1
        fi
        echo "Error response from daemon: latest tag not found locally" >&2
        exit 1
        ;;
    esac
    exit 0
    ;;
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
    // Apply path: docker pull ok, docker tag (source ghcr.io/...) ok,
    // compose up fails. attempt_rollback is invoked with prev_image_id=""
    // → MUST short-circuit before docker tag with a sha256:... source.
    writeStubs(stubs, {
      docker: `case "$1" in
  version) exit 0 ;;
  pull) exit 0 ;;
  tag)
    case "$2" in
      ghcr.io/caiopizzol/moor@*) exit 0 ;;
      *)
        echo "[stub] unexpected rollback docker tag with no prev_image_id: $2" >&2
        exit 99
        ;;
    esac
    ;;
  compose)
    verb=""
    for a in "$@"; do case "$a" in pull|up|version) verb="$a" ;; esac; done
    case "$verb" in
      up) echo "up failure" >&2; exit 1 ;;
    esac
    exit 0
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
  pull) exit 0 ;;
  tag) exit 0 ;;
  compose)
    verb=""
    for a in "$@"; do case "$a" in pull|up) verb="$a" ;; esac; done
    case "$verb" in
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

describe("respawner entrypoint apply: happy path success (#105)", () => {
  test("docker pull + tag + compose up + health pass → marker 'success', operator -f stack only, --pull never present", async () => {
    const dir = newTestDir();
    const stubs = newTestDir();
    const digest = `sha256:${"d".repeat(64)}`;
    writeContext(dir, 7, {
      target_digest: digest,
      // Use multiple config_files to assert the full operator stack is replayed.
      config_files: ["/root/moor/docker-compose.yml", "/root/moor/docker-compose.override.yml"],
    });
    writeStubs(stubs, { curl: `exit 0` });
    const r = await runApply({ dataDir: dir, stubsDir: stubs, auditId: 7, shrinkTimeouts: true });
    expect(r.exitCode).toBe(0);

    const marker = readMarker(dir, 7);
    expect(marker.state).toBe("success");
    expect(marker.error_log).toBeUndefined();
    expect(marker.rollback_error).toBeUndefined();

    const dockerCalls = readDockerLog(stubs);

    // #105: docker pull <repo>@<digest> happens first, then docker tag
    // retags :latest to that pulled image.
    const pullCall = dockerCalls.find((l) => l.startsWith("pull "));
    expect(pullCall).toBe(`pull ghcr.io/caiopizzol/moor@${digest}`);
    const tagCall = dockerCalls.find((l) => l.startsWith("tag "));
    expect(tagCall).toBe(`tag ghcr.io/caiopizzol/moor@${digest} ghcr.io/caiopizzol/moor:latest`);

    // compose up must have received the operator's full -f stack AND
    // --pull never AND NO moor-generated -f /app/data/.update-* entry
    // (the #105 contract: nothing we add gets baked into the next
    // container's config_files label). Also catches the POSIX set--
    // propagation bug class (the old build_compose_argv silently
    // dropped the operator stack).
    const upCall = dockerCalls.find((l) => l.includes(" up "));
    expect(upCall).toBeDefined();
    expect(upCall).toContain("-f /root/moor/docker-compose.yml");
    expect(upCall).toContain("-f /root/moor/docker-compose.override.yml");
    expect(upCall).toContain("--pull never");
    expect(upCall).not.toContain(".update-override-");
    expect(upCall).not.toContain(".update-rollback-");
    expect(upCall).not.toContain("/app/data/");
    expect(upCall).not.toContain(`${dir}/.update-`);

    // #105: no override or rollback files written on success.
    expect(existsSync(join(dir, ".update-rollback-7.yml"))).toBe(false);
    expect(existsSync(join(dir, ".update-override-7.yml"))).toBe(false);
    expect(listJunk(dir)).toEqual([]);
  });
});

describe("respawner entrypoint apply: -f stack on rollback path (#105)", () => {
  test("BOTH apply and rollback compose up use operator-only -f stack with --pull never; no moor-generated -f appended", async () => {
    const dir = newTestDir();
    const stubs = newTestDir();
    writeContext(dir, 9, {
      config_files: ["/root/moor/docker-compose.yml", "/root/moor/docker-compose.override.yml"],
    });
    // Counter distinguishes 1st up (apply, fail) from 2nd up
    // (rollback, succeed) since both have identical argv post-#105.
    const upCounter = join(dir, ".up-count");
    writeFileSync(upCounter, "0");
    writeStubs(stubs, {
      docker: `case "$1" in
  version) exit 0 ;;
  pull) exit 0 ;;
  tag) exit 0 ;;
  compose)
    verb=""
    for a in "$@"; do case "$a" in pull|up|version) verb="$a" ;; esac; done
    case "$verb" in
      up)
        n=$(cat ${upCounter} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${upCounter}
        if [ $n = 1 ]; then echo "apply up failure" >&2; exit 1; fi
        exit 0
        ;;
    esac
    exit 0
    ;;
  *) exit 0 ;;
esac`,
      curl: `exit 0`,
    });
    const r = await runApply({ dataDir: dir, stubsDir: stubs, auditId: 9, shrinkTimeouts: true });
    expect(r.exitCode).toBe(0);
    expect(readMarker(dir, 9).state).toBe("rolled_back");

    const dockerCalls = readDockerLog(stubs);
    const upCalls = dockerCalls.filter((l) => l.includes(" up "));
    expect(upCalls.length).toBe(2);
    // Both calls: full operator stack, --pull never, no moor-generated
    // -f (.update-override-* or .update-rollback-*) appended.
    for (const upCall of upCalls) {
      expect(upCall).toContain("-f /root/moor/docker-compose.yml");
      expect(upCall).toContain("-f /root/moor/docker-compose.override.yml");
      expect(upCall).toContain("--pull never");
      expect(upCall).not.toContain(".update-override-");
      expect(upCall).not.toContain(".update-rollback-");
      expect(upCall).not.toContain(`${dir}/.update-`);
    }

    // BOTH docker tag calls happen: apply (source=ghcr.io/...@digest)
    // and rollback (source=sha256:bbb...). Asserts the retag pattern is
    // actually used on both paths.
    const tagCalls = dockerCalls.filter((l) => l.startsWith("tag "));
    expect(tagCalls.length).toBe(2);
    expect(tagCalls[0]).toMatch(/^tag ghcr\.io\/caiopizzol\/moor@sha256:/);
    expect(tagCalls[1]).toMatch(/^tag sha256:/);
    expect(tagCalls[1]).toContain("ghcr.io/caiopizzol/moor:latest");

    // No artifact files left on disk on rollback success.
    expect(existsSync(join(dir, ".update-rollback-9.yml"))).toBe(false);
    expect(existsSync(join(dir, ".update-override-9.yml"))).toBe(false);
  });
});

describe("respawner entrypoint apply: tag failure during rollback (#105)", () => {
  test("rollback's docker tag fails → marker 'rollback_failed' with tag error in rollback_error", async () => {
    const dir = newTestDir();
    const stubs = newTestDir();
    writeContext(dir, 8);
    // Apply's docker tag (source ghcr.io/...) succeeds; rollback's
    // docker tag (source sha256:...) fails. Distinguishing by argv
    // keeps the apply path realistic instead of short-circuiting on
    // the apply tag, which would never trigger the rollback branch.
    writeStubs(stubs, {
      docker: `case "$1" in
  version) exit 0 ;;
  pull) exit 0 ;;
  tag)
    case "$2" in
      ghcr.io/caiopizzol/moor@*) exit 0 ;;
      sha256:*)
        echo "Error: no such image" >&2
        exit 1
        ;;
      *)
        echo "[stub] unexpected tag arg: $2" >&2
        exit 99
        ;;
    esac
    ;;
  compose)
    verb=""
    for a in "$@"; do case "$a" in pull|up) verb="$a" ;; esac; done
    case "$verb" in
      up) echo up-fail >&2; exit 1 ;;
    esac
    exit 0
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
