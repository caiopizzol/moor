// Tests for #80 PR #4 update-apply. Pure helpers tested directly;
// the orchestration is tested with fully-stubbed deps (no Docker,
// no real filesystem, no GHCR, no real backup).

process.env.MOOR_DB_PATH = ":memory:";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const { default: db } = await import("./db");
const { disableDrain, getDrainState } = await import("./drain");
const { hasInProgressAudit, listAudit } = await import("./update-audit");
const {
  TARGET_DIGEST_RE,
  applyUpdate,
  buildUpdateContextJson,
  buildUpdateOverrideYaml,
  classifyUnsafeReason,
  contextFilePath,
  isValidDigest,
  isValidServiceName,
  overrideFilePath,
} = await import("./update-apply");

import type { DiscoveryResult, MountRecord } from "./compose-context";
import type { UpdateStatusResponse } from "./update-status";

const VALID_DIGEST = `sha256:${"a".repeat(64)}`;
const OTHER_DIGEST = `sha256:${"b".repeat(64)}`;

function reset() {
  db.query("DELETE FROM update_audit").run();
  disableDrain();
}

// ---- Pure helpers ----------------------------------------------------

describe("#80 PR #4 isValidDigest", () => {
  test("accepts sha256:<64 hex>", () => {
    expect(isValidDigest(VALID_DIGEST)).toBe(true);
    expect(TARGET_DIGEST_RE.test(VALID_DIGEST)).toBe(true);
  });
  test("rejects wrong prefix, wrong length, uppercase, or whitespace", () => {
    expect(isValidDigest(`md5:${"a".repeat(64)}`)).toBe(false);
    expect(isValidDigest(`sha256:${"a".repeat(63)}`)).toBe(false);
    expect(isValidDigest(`sha256:${"a".repeat(65)}`)).toBe(false);
    expect(isValidDigest(`sha256:${"A".repeat(64)}`)).toBe(false);
    expect(isValidDigest(` ${VALID_DIGEST}`)).toBe(false);
    expect(isValidDigest(null)).toBe(false);
    expect(isValidDigest(undefined)).toBe(false);
  });
});

describe("#80 PR #4 isValidServiceName", () => {
  test("accepts alphanumeric + underscore + hyphen", () => {
    expect(isValidServiceName("moor")).toBe(true);
    expect(isValidServiceName("moor-api")).toBe(true);
    expect(isValidServiceName("moor_api")).toBe(true);
    expect(isValidServiceName("API42")).toBe(true);
  });
  test("rejects names with spaces, slashes, dots, or YAML metacharacters", () => {
    expect(isValidServiceName("moor api")).toBe(false);
    expect(isValidServiceName("moor/api")).toBe(false);
    expect(isValidServiceName("moor.api")).toBe(false);
    expect(isValidServiceName("moor:api")).toBe(false);
    expect(isValidServiceName('moor"')).toBe(false);
    expect(isValidServiceName("")).toBe(false);
  });
});

describe("#80 PR #4 buildUpdateOverrideYaml", () => {
  test("emits the documented shape", () => {
    const out = buildUpdateOverrideYaml("moor", VALID_DIGEST);
    expect(out).toContain("services:");
    expect(out).toContain("moor:");
    expect(out).toContain(`image: ghcr.io/caiopizzol/moor@${VALID_DIGEST}`);
  });
  test("throws on bad service name", () => {
    expect(() => buildUpdateOverrideYaml("bad name", VALID_DIGEST)).toThrow(/service name/);
  });
  test("throws on bad digest (defense in depth)", () => {
    expect(() => buildUpdateOverrideYaml("moor", "not-a-digest")).toThrow(/target_digest/);
  });
});

describe("#80 PR #4 buildUpdateContextJson", () => {
  test("round-trips through JSON.parse with the same shape", () => {
    const ctx = {
      audit_id: 7,
      target_digest: VALID_DIGEST,
      prev_image_id: "sha256:cafef00d",
      service: "moor",
      working_dir: "/root/moor",
      config_files: ["/root/moor/docker-compose.yml"],
      data_mount: {
        type: "volume" as const,
        name: "moor_moor-data",
        source: "/var/lib/docker/volumes/moor_moor-data/_data",
        destination: "/app/data",
      } satisfies MountRecord,
      network: "moor_default",
    };
    const parsed = JSON.parse(buildUpdateContextJson(ctx));
    expect(parsed).toEqual(ctx);
  });
});

describe("#80 PR #4 file-path helpers", () => {
  test("contextFilePath + overrideFilePath use the documented basenames", () => {
    expect(contextFilePath("/app/data", 42)).toBe("/app/data/.update-context-42.json");
    expect(overrideFilePath("/app/data", 42)).toBe("/app/data/.update-override-42.yml");
  });
});

// ---- Orchestration --------------------------------------------------

// Helper to build a fully-overridden deps record without polluting the
// individual test bodies.
function makeDeps(overrides: Record<string, unknown> = {}) {
  const goodStatus: UpdateStatusResponse = {
    current: {
      version: "0.39.0",
      image_id: "sha256:img",
      repo_digest: VALID_DIGEST,
      started_at: "",
    },
    available: {
      latest_tag: "latest",
      latest_digest: OTHER_DIGEST,
      update_available: true,
      registry_error: null,
    },
    active_work: { builds_in_flight: 0, execs_in_flight: 0, crons_in_flight: 0, terminals_open: 0 },
    db_backup: { last_backup_at: null, age_seconds: null, location: null },
    safe_to_update: true,
    unsafe_reasons: [],
    recommended_command: "",
  };
  const goodContext: DiscoveryResult = {
    ok: true,
    context: {
      labels: {
        project: "moor",
        service: "moor",
        working_dir: "/root/moor",
        config_files: ["/root/moor/docker-compose.yml"],
      },
      data_mount: {
        type: "volume",
        name: "moor_moor-data",
        source: "/var/lib/docker/volumes/moor_moor-data/_data",
        destination: "/app/data",
      },
      default_network: "moor_default",
    },
  };

  const writes: { path: string; content: string }[] = [];
  const launches: unknown[] = [];

  const base = {
    getStatus: async () => goodStatus,
    discoverContext: async () => goodContext,
    getCurrentImage: async () => ({
      image_id: "sha256:img",
      repo_digest: VALID_DIGEST,
      started_at: "",
    }),
    takeBackup: async (_dir: string) => ({ path: "/tmp/fake-backup" }),
    writeFile: (path: string, content: string) => {
      writes.push({ path, content });
    },
    launchRespawner: async (opts: unknown) => {
      launches.push(opts);
    },
    resolveDataDir: () => "/app/data",
    runningVersion: () => "0.39.0",
  };

  return { deps: { ...base, ...overrides }, writes, launches };
}

describe("update-apply: classifyUnsafeReason (default-deny contract)", () => {
  test("active-work reasons → 'active_work'", () => {
    expect(classifyUnsafeReason("2 build/pull in flight")).toBe("active_work");
    expect(classifyUnsafeReason("1 async exec in flight")).toBe("active_work");
    expect(classifyUnsafeReason("3 cron run in flight")).toBe("active_work");
    expect(classifyUnsafeReason("5 project terminal(s) open")).toBe("active_work");
  });
  test("backup reasons → 'backup'", () => {
    expect(
      classifyUnsafeReason(
        "no recent DB backup (run moor_db_backup or set MOOR_DB_BACKUP_INTERVAL_HOURS; see #90)",
      ),
    ).toBe("backup");
    expect(classifyUnsafeReason("last backup 73h ago (older than 24h)")).toBe("backup");
  });
  test("anything else → 'unknown' (default-deny)", () => {
    expect(classifyUnsafeReason("disk pressure too high")).toBe("unknown");
    expect(classifyUnsafeReason("something brand new from a future moor")).toBe("unknown");
    expect(classifyUnsafeReason("")).toBe("unknown");
  });
});

describe("#80 PR #4 applyUpdate — preflight refusals", () => {
  beforeEach(reset);
  afterEach(reset);

  test("active work + no bypass → preflight_failed, NO audit row inserted, NO drain", async () => {
    const { deps } = makeDeps({
      getStatus: async () => ({
        ...((await makeDeps().deps.getStatus()) as UpdateStatusResponse),
        active_work: {
          builds_in_flight: 1,
          execs_in_flight: 0,
          crons_in_flight: 0,
          terminals_open: 0,
        },
        unsafe_reasons: ["1 build/pull in flight"],
      }),
    });
    const r = await applyUpdate({}, deps);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("preflight_failed");
    expect(listAudit().length).toBe(0);
    expect(getDrainState().enabled).toBe(false);
  });

  test("unknown unsafe_reason → preflight_failed even with no bypass set", async () => {
    const { deps } = makeDeps({
      getStatus: async () => {
        const base = (await makeDeps().deps.getStatus()) as UpdateStatusResponse;
        return { ...base, unsafe_reasons: ["disk pressure too high"] };
      },
    });
    const r = await applyUpdate({}, deps);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("preflight_failed");
    expect((r.error as { reason: string }).reason).toContain("unsafe_reasons not in");
    expect((r.error as { reason: string }).reason).toContain("disk pressure too high");
    expect(listAudit().length).toBe(0);
  });

  test("unknown unsafe_reason → still refused even with bypass:['active_work']", async () => {
    const { deps } = makeDeps({
      getStatus: async () => {
        const base = (await makeDeps().deps.getStatus()) as UpdateStatusResponse;
        return { ...base, unsafe_reasons: ["disk pressure too high"] };
      },
    });
    const r = await applyUpdate({ bypass: ["active_work"] }, deps);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("preflight_failed");
    // unknown is not bypassable by any flag
  });

  test("backup-only unsafe_reason → silently accepted (fresh backup will satisfy)", async () => {
    const { deps, launches } = makeDeps({
      getStatus: async () => {
        const base = (await makeDeps().deps.getStatus()) as UpdateStatusResponse;
        return {
          ...base,
          unsafe_reasons: ["last backup 50h ago (older than 24h)"],
        };
      },
    });
    const r = await applyUpdate({}, deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(launches.length).toBe(1);
  });

  test("mixed: active_work + unknown → refused on unknown (more conservative wins)", async () => {
    const { deps } = makeDeps({
      getStatus: async () => {
        const base = (await makeDeps().deps.getStatus()) as UpdateStatusResponse;
        return {
          ...base,
          unsafe_reasons: ["1 build/pull in flight", "disk pressure too high"],
        };
      },
    });
    const r = await applyUpdate({ bypass: ["active_work"] }, deps);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect((r.error as { reason: string }).reason).toContain("disk pressure too high");
  });

  test("active work + bypass:['active_work'] → proceeds to insert audit", async () => {
    const { deps, launches } = makeDeps({
      getStatus: async () => ({
        ...((await makeDeps().deps.getStatus()) as UpdateStatusResponse),
        active_work: {
          builds_in_flight: 1,
          execs_in_flight: 0,
          crons_in_flight: 0,
          terminals_open: 0,
        },
        // unsafe_reasons reflects active work but we bypass it.
        unsafe_reasons: ["1 build/pull in flight"],
      }),
    });
    // For the post-drain re-check, make active counts zero so we proceed.
    let callCount = 0;
    deps.getStatus = async () => {
      callCount++;
      const base = (await makeDeps().deps.getStatus()) as UpdateStatusResponse;
      return callCount === 1
        ? {
            ...base,
            active_work: {
              builds_in_flight: 1,
              execs_in_flight: 0,
              crons_in_flight: 0,
              terminals_open: 0,
            },
            unsafe_reasons: ["1 build/pull in flight"],
          }
        : base;
    };
    const r = await applyUpdate({ bypass: ["active_work"] }, deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(launches.length).toBe(1);
  });

  test("update_available=null + no bypass → preflight_failed with registry hint", async () => {
    const { deps } = makeDeps({
      getStatus: async () => {
        const base = (await makeDeps().deps.getStatus()) as UpdateStatusResponse;
        return {
          ...base,
          available: {
            ...base.available,
            latest_digest: null,
            update_available: null,
            registry_error: "ECONNREFUSED",
          },
        };
      },
    });
    const r = await applyUpdate({}, deps);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("preflight_failed");
    expect(listAudit().length).toBe(0);
  });

  test("update_available=false (already latest) without explicit target_digest → refused (no-op apply)", async () => {
    const { deps } = makeDeps({
      getStatus: async () => {
        const base = (await makeDeps().deps.getStatus()) as UpdateStatusResponse;
        return {
          ...base,
          // Same digest both sides → already latest.
          available: {
            ...base.available,
            latest_digest: VALID_DIGEST,
            update_available: false,
          },
          current: { ...base.current, repo_digest: VALID_DIGEST },
        };
      },
    });
    const r = await applyUpdate({}, deps);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("preflight_failed");
    expect((r.error as { reason: string }).reason).toContain("already on the latest digest");
    expect(listAudit().length).toBe(0);
  });

  test("update_available=false WITH explicit target_digest → proceeds (intentional re-apply)", async () => {
    const { deps, launches } = makeDeps({
      getStatus: async () => {
        const base = (await makeDeps().deps.getStatus()) as UpdateStatusResponse;
        return {
          ...base,
          available: {
            ...base.available,
            latest_digest: VALID_DIGEST,
            update_available: false,
          },
          current: { ...base.current, repo_digest: VALID_DIGEST },
        };
      },
    });
    const r = await applyUpdate({ target_digest: VALID_DIGEST }, deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(launches.length).toBe(1);
  });

  test("update_available=null + bypass without explicit target_digest → still refused (no digest to pin)", async () => {
    const { deps } = makeDeps({
      getStatus: async () => {
        const base = (await makeDeps().deps.getStatus()) as UpdateStatusResponse;
        return {
          ...base,
          available: {
            ...base.available,
            latest_digest: null,
            update_available: null,
            registry_error: null,
          },
        };
      },
    });
    const r = await applyUpdate({ bypass: ["unknown_digest"] }, deps);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("preflight_failed");
    expect((r.error as { reason: string }).reason).toContain("target_digest");
  });
});

describe("#80 PR #4 applyUpdate — discovery + image-inspect refusals", () => {
  beforeEach(reset);
  afterEach(reset);

  test("context_failed when labels are missing", async () => {
    const { deps } = makeDeps({
      discoverContext: async () =>
        ({
          ok: false,
          error: { reason: "missing_labels", message: "no labels" },
        }) satisfies DiscoveryResult,
    });
    const r = await applyUpdate({}, deps);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("context_failed");
    expect(listAudit().length).toBe(0);
  });

  test("current_image_unknown when self-inspect returns no image_id", async () => {
    const { deps } = makeDeps({
      getCurrentImage: async () => ({ image_id: null, repo_digest: null, started_at: "" }),
    });
    const r = await applyUpdate({}, deps);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("current_image_unknown");
    expect(listAudit().length).toBe(0);
  });
});

describe("#80 PR #4 applyUpdate — concurrency + race", () => {
  beforeEach(reset);
  afterEach(reset);

  test("hasInProgressAudit blocks a second apply", async () => {
    const { deps } = makeDeps();
    const r1 = await applyUpdate({}, deps);
    expect(r1.ok).toBe(true);

    const r2 = await applyUpdate({}, deps);
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.error.code).toBe("already_in_progress");
  });

  test("race_active_work: re-check after drain sees active work → 'failed' + drain cleared", async () => {
    let callCount = 0;
    const { deps } = makeDeps({
      getStatus: async () => {
        callCount++;
        const base = (await makeDeps().deps.getStatus()) as UpdateStatusResponse;
        // 1st call (preflight): clean. 2nd call (re-check): active work appeared.
        if (callCount === 1) return base;
        return {
          ...base,
          active_work: {
            builds_in_flight: 2,
            execs_in_flight: 0,
            crons_in_flight: 0,
            terminals_open: 0,
          },
        };
      },
    });
    const r = await applyUpdate({}, deps);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("race_active_work");

    const rows = listAudit();
    expect(rows.length).toBe(1);
    expect(rows[0].state).toBe("failed");
    expect(rows[0].error_log).toContain("race");
    expect(getDrainState().enabled).toBe(false);
  });
});

describe("#80 PR #4 applyUpdate — backup + launch failure paths", () => {
  beforeEach(reset);
  afterEach(reset);

  test("backup throws → 'failed' + drain cleared + audit row carries reason", async () => {
    const { deps, launches } = makeDeps({
      takeBackup: async () => {
        throw new Error("disk full");
      },
    });
    const r = await applyUpdate({}, deps);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("backup_failed");
    expect(launches.length).toBe(0); // never reached the launcher

    const rows = listAudit();
    expect(rows.length).toBe(1);
    expect(rows[0].state).toBe("failed");
    expect(rows[0].error_log).toContain("disk full");
    expect(rows[0].backup_path).toBeNull();
    expect(getDrainState().enabled).toBe(false);
  });

  test("launcher throws → 'failed' + drain cleared + backup_path was set first", async () => {
    const { deps, writes } = makeDeps({
      launchRespawner: async () => {
        throw new Error("pull manifest unknown");
      },
    });
    const r = await applyUpdate({}, deps);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("respawner_launch_failed");

    const rows = listAudit();
    expect(rows[0].state).toBe("failed");
    expect(rows[0].error_log).toContain("pull manifest unknown");
    expect(rows[0].backup_path).toBe("/tmp/fake-backup");
    expect(getDrainState().enabled).toBe(false);

    // Context + override WERE written before launch was attempted.
    expect(writes.some((w) => w.path.includes(".update-context-"))).toBe(true);
    expect(writes.some((w) => w.path.includes(".update-override-"))).toBe(true);
  });
});

describe("#80 PR #4 applyUpdate — happy path", () => {
  beforeEach(reset);
  afterEach(reset);

  test("ok: returns audit_id; audit in_progress; drain enabled WITHOUT clear_after_version; files + launcher", async () => {
    const { deps, writes, launches } = makeDeps();
    const r = await applyUpdate({}, deps);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const auditId = r.audit_id;

    // Audit row in_progress, with backup path + digests captured.
    const row = listAudit()[0];
    expect(row.id).toBe(auditId);
    expect(row.state).toBe("in_progress");
    expect(row.from_digest).toBe(VALID_DIGEST);
    expect(row.to_digest).toBe(OTHER_DIGEST);
    expect(row.prev_image_id).toBe("sha256:img");
    expect(row.backup_path).toBe("/tmp/fake-backup");

    // Drain ON with the audit-id reason; clear_after_version NOT set.
    const drain = getDrainState();
    expect(drain.enabled).toBe(true);
    expect(drain.reason).toContain(String(auditId));
    expect(drain.clear_after_version).toBeNull();

    // Context + override written with expected paths + parseable content.
    const ctxFile = writes.find((w) => w.path.endsWith(`.update-context-${auditId}.json`));
    expect(ctxFile).toBeDefined();
    const ctxParsed = JSON.parse(ctxFile?.content ?? "{}");
    expect(ctxParsed.audit_id).toBe(auditId);
    expect(ctxParsed.target_digest).toBe(OTHER_DIGEST);
    expect(ctxParsed.service).toBe("moor");
    expect(ctxParsed.network).toBe("moor_default");

    const ovFile = writes.find((w) => w.path.endsWith(`.update-override-${auditId}.yml`));
    expect(ovFile).toBeDefined();
    expect(ovFile?.content).toContain(`image: ghcr.io/caiopizzol/moor@${OTHER_DIGEST}`);

    // Launcher called with running version (0.39.0), not target version.
    expect(launches.length).toBe(1);
    const launchOpts = launches[0] as { respawner_image: string; audit_id: number };
    expect(launchOpts.respawner_image).toBe("ghcr.io/caiopizzol/moor-respawner:0.39.0");
    expect(launchOpts.audit_id).toBe(auditId);

    // hasInProgressAudit reflects state.
    expect(hasInProgressAudit()).toBe(true);
  });

  test("explicit target_digest overrides registry latest", async () => {
    const explicit = `sha256:${"c".repeat(64)}`;
    const { deps, writes } = makeDeps();
    const r = await applyUpdate({ target_digest: explicit }, deps);
    expect(r.ok).toBe(true);
    const ovFile = writes.find((w) => w.path.includes(".update-override-"));
    expect(ovFile?.content).toContain(`@${explicit}`);
  });
});
