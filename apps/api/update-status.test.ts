// Tests for #78 update-status. Pure helpers are unit-tested
// directly. The integration test for buildUpdateStatus injects a
// GhcrFetcher mock — no real registry round-trip in tests, no
// dependency on local Docker for the GHCR side. (The Docker-side
// helpers — getCurrentImageInfo — are exercised via live smoke
// since mocking the unix-socket fetch is more setup than payoff
// for this PR.)

process.env.MOOR_DB_PATH = ":memory:";

import { beforeEach, describe, expect, test } from "bun:test";

const { default: db } = await import("./db");
const {
  buildUpdateStatus,
  buildUnsafeReasons,
  compareForUpdate,
  extractRepoDigest,
  getActiveWorkCounts,
  readPackageVersion,
} = await import("./update-status");

describe("#78 extractRepoDigest", () => {
  test("picks the first sha256-bearing entry", () => {
    expect(
      extractRepoDigest(["ghcr.io/caiopizzol/moor@sha256:abc", "other.registry/moor@sha256:def"]),
    ).toBe("ghcr.io/caiopizzol/moor@sha256:abc");
  });

  test("returns null when array is empty/null/undefined", () => {
    expect(extractRepoDigest(null)).toBeNull();
    expect(extractRepoDigest(undefined)).toBeNull();
    expect(extractRepoDigest([])).toBeNull();
  });

  test("returns null when no entry contains @sha256: (locally-built image)", () => {
    expect(extractRepoDigest(["ghcr.io/caiopizzol/moor:latest"])).toBeNull();
  });

  test("skips malformed entries and returns the first valid one", () => {
    expect(extractRepoDigest(["not-a-digest", "ghcr.io/caiopizzol/moor@sha256:valid"])).toBe(
      "ghcr.io/caiopizzol/moor@sha256:valid",
    );
  });
});

describe("#78 compareForUpdate — never lies across identifier spaces", () => {
  test("equal sha → not available", () => {
    expect(compareForUpdate("ghcr.io/caiopizzol/moor@sha256:abc", "sha256:abc")).toBe(false);
  });

  test("different sha → available", () => {
    expect(compareForUpdate("ghcr.io/caiopizzol/moor@sha256:abc", "sha256:def")).toBe(true);
  });

  test("null current → unknown (NOT false)", () => {
    expect(compareForUpdate(null, "sha256:def")).toBeNull();
  });

  test("null latest → unknown (NOT false)", () => {
    expect(compareForUpdate("ghcr.io/caiopizzol/moor@sha256:abc", null)).toBeNull();
  });

  test("both null → unknown", () => {
    expect(compareForUpdate(null, null)).toBeNull();
  });

  test("handles both sides being bare 'sha256:' digests", () => {
    expect(compareForUpdate("sha256:abc", "sha256:abc")).toBe(false);
    expect(compareForUpdate("sha256:abc", "sha256:def")).toBe(true);
  });
});

describe("#78 buildUnsafeReasons", () => {
  test("returns [] when everything is clear (and backup is recent)", () => {
    expect(
      buildUnsafeReasons({
        builds_in_flight: 0,
        execs_in_flight: 0,
        crons_in_flight: 0,
        terminals_open: 0,
        backup_age_seconds: 60, // 1 minute ago
      }),
    ).toEqual([]);
  });

  test("includes a specific reason per active-work category", () => {
    const reasons = buildUnsafeReasons({
      builds_in_flight: 2,
      execs_in_flight: 1,
      crons_in_flight: 1,
      terminals_open: 3,
      backup_age_seconds: 60,
    });
    expect(reasons).toContain("2 build/pull in flight");
    expect(reasons).toContain("1 async exec in flight");
    expect(reasons).toContain("1 cron run in flight");
    expect(reasons).toContain("3 project terminal(s) open");
  });

  test("null backup_age_seconds → 'no recent DB backup' with #90 hint", () => {
    const reasons = buildUnsafeReasons({
      builds_in_flight: 0,
      execs_in_flight: 0,
      crons_in_flight: 0,
      terminals_open: 0,
      backup_age_seconds: null,
    });
    expect(reasons.length).toBe(1);
    expect(reasons[0]).toContain("no recent DB backup");
    expect(reasons[0]).toContain("moor_db_backup");
    expect(reasons[0]).toContain("MOOR_DB_BACKUP_INTERVAL_HOURS");
    expect(reasons[0]).toContain("#90");
  });

  test("backup older than 24h → reports the age in hours", () => {
    const reasons = buildUnsafeReasons({
      builds_in_flight: 0,
      execs_in_flight: 0,
      crons_in_flight: 0,
      terminals_open: 0,
      backup_age_seconds: 73 * 3600,
    });
    expect(reasons.some((r) => r.includes("73h"))).toBe(true);
  });
});

describe("#78 getActiveWorkCounts", () => {
  beforeEach(() => {
    db.query("DELETE FROM runs").run();
    db.query("DELETE FROM exec_runs").run();
    db.query("DELETE FROM crons").run();
    db.query("DELETE FROM projects").run();
  });

  test("zero counts when nothing is in flight", () => {
    const counts = getActiveWorkCounts();
    expect(counts.builds_in_flight).toBe(0);
    expect(counts.execs_in_flight).toBe(0);
    expect(counts.crons_in_flight).toBe(0);
    expect(counts.terminals_open).toBe(0);
  });

  test("distinguishes cron_id NULL (build/manual) from NOT NULL (cron)", () => {
    const p = db.query("INSERT INTO projects (name) VALUES ('p') RETURNING id").get() as {
      id: number;
    };
    const c = db
      .query(
        "INSERT INTO crons (project_id, name, schedule, command) VALUES (?, 'c', '* * * * *', 'echo') RETURNING id",
      )
      .get(p.id) as { id: number };
    // 1 build run in-flight, 1 cron run in-flight
    db.query(
      "INSERT INTO runs (project_id, cron_id, started_at) VALUES (?, NULL, datetime('now'))",
    ).run(p.id);
    db.query(
      "INSERT INTO runs (project_id, cron_id, started_at) VALUES (?, ?, datetime('now'))",
    ).run(p.id, c.id);

    const counts = getActiveWorkCounts();
    expect(counts.builds_in_flight).toBe(1);
    expect(counts.crons_in_flight).toBe(1);
  });

  test("only counts exec_runs in state='running'", () => {
    const p = db.query("INSERT INTO projects (name) VALUES ('p') RETURNING id").get() as {
      id: number;
    };
    db.query(
      "INSERT INTO exec_runs (project_id, command, state, timeout_ms) VALUES (?, 'x', 'running', 60000)",
    ).run(p.id);
    db.query(
      "INSERT INTO exec_runs (project_id, command, state, timeout_ms) VALUES (?, 'x', 'exited', 60000)",
    ).run(p.id);

    const counts = getActiveWorkCounts();
    expect(counts.execs_in_flight).toBe(1);
  });
});

describe("#78 buildUpdateStatus integration with injected GhcrFetcher", () => {
  beforeEach(() => {
    db.query("DELETE FROM runs").run();
    db.query("DELETE FROM exec_runs").run();
    db.query("DELETE FROM crons").run();
    db.query("DELETE FROM projects").run();
  });

  test("registry unreachable → update_available=null, registry_error populated, NOT false", async () => {
    const status = await buildUpdateStatus(async () => ({
      ok: false,
      error: "ECONNREFUSED",
    }));
    expect(status.available.latest_digest).toBeNull();
    expect(status.available.registry_error).toBe("ECONNREFUSED");
    // Critically null, not false — false would lie ("we checked, you're up to date")
    expect(status.available.update_available).toBeNull();
  });

  test("locally-built moor (no repo_digest) + registry reachable → update_available=null still", async () => {
    // getCurrentImageInfo can't return repo_digest in this test env
    // (no HOSTNAME for a real container), so this is the natural case.
    const status = await buildUpdateStatus(async () => ({
      ok: true,
      digest: "sha256:abc",
    }));
    expect(status.available.latest_digest).toBe("sha256:abc");
    expect(status.current.repo_digest).toBeNull();
    expect(status.available.update_available).toBeNull();
  });

  test("safe_to_update is false when no backup exists; reason references #90", async () => {
    // The test env is in-memory (MOOR_DB_PATH=:memory:), so the backup
    // directory is unavailable and getLatestBackupInfo degrades to null
    // — same shape as a fresh install with no scheduler enabled.
    const status = await buildUpdateStatus(async () => ({
      ok: false,
      error: "stub",
    }));
    expect(status.safe_to_update).toBe(false);
    const backupReason = status.unsafe_reasons.find((r) => r.includes("no recent DB backup"));
    expect(backupReason).toBeDefined();
    expect(backupReason).toContain("#90");
  });

  test("recommended_command uses --no-deps --wait", async () => {
    const status = await buildUpdateStatus(async () => ({
      ok: false,
      error: "stub",
    }));
    expect(status.recommended_command).toContain("--no-deps");
    expect(status.recommended_command).toContain("--wait");
  });
});

describe("#78 readPackageVersion", () => {
  test("matches the root package.json version (the one semantic-release bumps), not apps/api/package.json", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const rootPath = join(import.meta.dir, "..", "..", "package.json");
    const apiPath = join(import.meta.dir, "package.json");
    const rootVersion = (JSON.parse(readFileSync(rootPath, "utf-8")) as { version: string })
      .version;
    const apiVersion = (JSON.parse(readFileSync(apiPath, "utf-8")) as { version: string }).version;
    // Guard: this test is only meaningful while the two diverge.
    expect(rootVersion).not.toBe(apiVersion);
    expect(readPackageVersion()).toBe(rootVersion);
  });
});
