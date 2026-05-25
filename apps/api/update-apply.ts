// #80 PR #4: moor_update_apply happy path. Orchestrates preflight,
// drain, audit row insertion, fresh backup, override/context file
// writes, and respawner launch. NO ROLLBACK — that lands in PR #5.
// A failed up/wait/health in this PR writes a `failed` marker; the
// compose state is left as Compose left it, and recovery is manual
// (`docker compose up`) or the 30-min stale-in_progress sweep.
//
// The orchestration is split from the side effects so tests can
// inject the launcher / backup / file writer without spinning up
// real Docker or touching the filesystem.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DiscoveryResult, MountRecord } from "./compose-context";
import { discoverComposeContext } from "./compose-context";
import { DEFAULT_KEEP_BACKUPS, defaultBackupDir, runBackup } from "./db-backup";
import { SOCKET as SOCKET_PATH } from "./docker";
import { disableDrain, enableDrain } from "./drain";
import {
  finalizeAudit,
  hasInProgressAudit,
  insertAuditInProgress,
  setBackupPath,
} from "./update-audit";
import {
  buildUpdateStatus,
  getCurrentImageInfo,
  readPackageVersion,
  realGhcrFetch,
  type UpdateStatusResponse,
} from "./update-status";

// ---- Pure helpers ----------------------------------------------------

/** Defense-in-depth: target digest must be exactly `sha256:<64 hex>`.
 *  Catches typos and prevents shell/YAML injection via a crafted
 *  digest string. */
export const TARGET_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/** Unsafe-reason classifiers. Each pattern matches the substrings
 *  emitted by buildUnsafeReasons in update-status.ts. The contract:
 *  every reason produced there must match exactly one of these, or
 *  the apply path will default-deny it as `unknown`. New unsafe
 *  categories require an explicit decision here (bypass-able / silent
 *  / default-deny), not silent acceptance. */
export const ACTIVE_WORK_REASON_PATTERN =
  /build\/pull in flight|async exec in flight|cron run in flight|project terminal\(s\) open/;
export const BACKUP_REASON_PATTERN = /no recent DB backup|last backup \d+h ago/;

export function classifyUnsafeReason(reason: string): "active_work" | "backup" | "unknown" {
  if (ACTIVE_WORK_REASON_PATTERN.test(reason)) return "active_work";
  if (BACKUP_REASON_PATTERN.test(reason)) return "backup";
  return "unknown";
}
export function isValidDigest(s: string | null | undefined): s is string {
  return typeof s === "string" && TARGET_DIGEST_RE.test(s);
}

/** Defense-in-depth: Compose service names from labels SHOULD be safe,
 *  but we're about to interpolate one into YAML — assert the shape we
 *  expect (alphanumeric + underscore + hyphen). */
export const SERVICE_NAME_RE = /^[a-zA-Z0-9_-]+$/;
export function isValidServiceName(s: string): boolean {
  return SERVICE_NAME_RE.test(s);
}

/** Pure: build the Compose override YAML pinning `<service>` to the
 *  target digest. Both inputs are validated again — throwing here
 *  rather than emitting unsafe YAML.
 *
 *  Repo is hardcoded to ghcr.io/caiopizzol/moor; this module exists
 *  to update THIS moor, so the repo is invariant. */
export function buildUpdateOverrideYaml(service: string, targetDigest: string): string {
  if (!isValidServiceName(service)) {
    throw new Error(`buildUpdateOverrideYaml: invalid service name ${JSON.stringify(service)}`);
  }
  if (!isValidDigest(targetDigest)) {
    throw new Error(
      `buildUpdateOverrideYaml: invalid target_digest ${JSON.stringify(targetDigest)}`,
    );
  }
  return [
    "services:",
    `  ${service}:`,
    `    image: ghcr.io/caiopizzol/moor@${targetDigest}`,
    "",
  ].join("\n");
}

export type UpdateContext = {
  audit_id: number;
  target_digest: string;
  prev_image_id: string | null;
  service: string;
  working_dir: string;
  config_files: string[];
  data_mount: MountRecord;
  network: string;
};

/** Pure: serialize the structured update context the respawner reads
 *  via jq. Pretty-printed for operator-friendly inspection of the
 *  on-disk file. */
export function buildUpdateContextJson(ctx: UpdateContext): string {
  return `${JSON.stringify(ctx, null, 2)}\n`;
}

export function contextFilePath(dir: string, auditId: number): string {
  return join(dir, `.update-context-${auditId}.json`);
}

export function overrideFilePath(dir: string, auditId: number): string {
  return join(dir, `.update-override-${auditId}.yml`);
}

// ---- Orchestration --------------------------------------------------

export type ApplyInput = {
  target_digest?: string;
  bypass?: ("active_work" | "unknown_digest")[];
};

export type ApplyError =
  | { code: "preflight_failed"; reason: string; unsafe_reasons?: string[] }
  | { code: "context_failed"; reason: string }
  | { code: "current_image_unknown"; reason: string }
  | { code: "already_in_progress" }
  | { code: "race_active_work"; counts: Record<string, number> }
  | { code: "backup_failed"; reason: string }
  | { code: "respawner_launch_failed"; reason: string };

export type ApplyResult = { ok: true; audit_id: number } | { ok: false; error: ApplyError };

export type RespawnerLaunchOpts = {
  audit_id: number;
  respawner_image: string;
  working_dir: string;
  data_mount: MountRecord;
  network: string;
};

/** Inject for tests. Pull → create → start. Throws on any failure;
 *  the error message becomes the audit row's error_log. */
export type RespawnerLauncher = (opts: RespawnerLaunchOpts) => Promise<void>;

export type ApplyDeps = {
  getStatus: () => Promise<UpdateStatusResponse>;
  discoverContext: () => Promise<DiscoveryResult>;
  getCurrentImage: () => Promise<{
    image_id: string | null;
    repo_digest: string | null;
    started_at: string;
  }>;
  takeBackup: (dir: string) => Promise<{ path: string }>;
  writeFile: (path: string, content: string) => void;
  launchRespawner: RespawnerLauncher;
  resolveDataDir: () => string;
  // The version moor pulls of the respawner. Defaults to
  // readPackageVersion() so respawner version always matches the moor
  // that launched it.
  runningVersion: () => string;
};

// Default deps wire the production implementations. Tests pass a
// partial overlay to swap any of these out — all eight are injectable
// so no test needs Docker, GHCR, or a real filesystem to exercise the
// orchestration.
function makeDefaultDeps(): ApplyDeps {
  return {
    getStatus: () => buildUpdateStatus(realGhcrFetch),
    discoverContext: () => discoverComposeContext(),
    getCurrentImage: () => getCurrentImageInfo(),
    takeBackup: async (dir) => {
      const r = runBackup({ dir, keep: DEFAULT_KEEP_BACKUPS });
      return { path: r.path };
    },
    writeFile: (path, content) => writeFileSync(path, content, { mode: 0o600 }),
    // Real launcher is defined further below in this file.
    launchRespawner: (opts) => realLaunchRespawner(opts),
    resolveDataDir: defaultBackupDir,
    runningVersion: readPackageVersion,
  };
}

const DRAIN_REASON = (auditId: number) => `update in progress (audit_id=${auditId})`;
const DRAIN_TTL_MIN = 30;

/** Main orchestration. See PR #4 design comment on #80 for the locked
 *  contract. Steps are numbered to match the design. */
export async function applyUpdate(
  input: ApplyInput,
  partialDeps?: Partial<ApplyDeps>,
): Promise<ApplyResult> {
  const deps: ApplyDeps = { ...makeDefaultDeps(), ...partialDeps };
  const bypass = new Set(input.bypass ?? []);

  // 1. Preflight via the same module moor_update_status uses.
  const status = await deps.getStatus();

  if (status.available.update_available === null && !bypass.has("unknown_digest")) {
    return {
      ok: false,
      error: {
        code: "preflight_failed",
        reason:
          status.available.registry_error ??
          'update_available is unknown (locally-built image?); pass bypass: ["unknown_digest"] to apply anyway',
      },
    };
  }

  // Classify every unsafe_reason into one of three buckets:
  //   active_work — bypassable via bypass: ["active_work"]
  //   backup     — silently accepted because step 8 below takes a fresh
  //                VACUUM INTO that satisfies any preflight backup warning
  //   unknown    — DEFAULT-DENY. moor_update_status is the safety contract;
  //                if it grew a new category we don't know how to evaluate,
  //                an updater that silently accepts it would betray the
  //                contract. Refuse and surface the unknown reasons so the
  //                operator can decide whether to add explicit handling.
  const activeWorkReasons: string[] = [];
  const unknownReasons: string[] = [];
  for (const reason of status.unsafe_reasons) {
    if (ACTIVE_WORK_REASON_PATTERN.test(reason)) {
      activeWorkReasons.push(reason);
    } else if (BACKUP_REASON_PATTERN.test(reason)) {
      // intentional no-op: fresh backup below satisfies this
    } else {
      unknownReasons.push(reason);
    }
  }
  if (unknownReasons.length > 0) {
    return {
      ok: false,
      error: {
        code: "preflight_failed",
        reason: `unsafe_reasons not in active_work or backup category; refusing to silently accept: ${unknownReasons.join("; ")}. Review and add explicit handling.`,
        unsafe_reasons: status.unsafe_reasons,
      },
    };
  }
  if (activeWorkReasons.length > 0 && !bypass.has("active_work")) {
    return {
      ok: false,
      error: {
        code: "preflight_failed",
        reason: `active work in flight; pass bypass: ["active_work"] to interrupt and proceed`,
        unsafe_reasons: status.unsafe_reasons,
      },
    };
  }

  // Refuse a no-op apply when nothing's actually new AND the operator
  // didn't explicitly request a specific digest. Without this guard,
  // `moor_update_apply` would restart moor for no functional gain.
  // An explicit `target_digest` (even matching current) is treated as
  // intentional — operators sometimes pin to re-verify the current
  // release; that's their call.
  if (status.available.update_available === false && input.target_digest === undefined) {
    return {
      ok: false,
      error: {
        code: "preflight_failed",
        reason:
          "already on the latest digest; no update to apply. Pass an explicit target_digest if you want to re-apply intentionally.",
      },
    };
  }

  // Target digest: explicit input wins; otherwise use the registry's
  // latest. If still null (no input + unreachable registry), we either
  // bypassed unknown_digest above (refuse to write a YAML override with
  // an empty image) or we wouldn't have gotten here.
  const candidateDigest = input.target_digest ?? status.available.latest_digest;
  if (!isValidDigest(candidateDigest)) {
    return {
      ok: false,
      error: {
        code: "preflight_failed",
        reason: `target_digest not a valid sha256:<64 hex>: ${JSON.stringify(candidateDigest)}`,
      },
    };
  }
  const targetDigest: string = candidateDigest;

  // 2. Discover compose context (labels, mount, network).
  const ctx = await deps.discoverContext();
  if (!ctx.ok) {
    return { ok: false, error: { code: "context_failed", reason: ctx.error.message } };
  }
  const { labels, data_mount, default_network } = ctx.context;

  if (!isValidServiceName(labels.service)) {
    return {
      ok: false,
      error: {
        code: "context_failed",
        reason: `service name from compose label is not safe to interpolate: ${JSON.stringify(labels.service)}`,
      },
    };
  }

  // 3. Re-inspect current image at apply time so prev_image_id reflects
  // reality, not the value moor_update_status may have cached.
  const current = await deps.getCurrentImage();
  if (!current.image_id) {
    return {
      ok: false,
      error: {
        code: "current_image_unknown",
        reason:
          "could not inspect own container to capture prev_image_id (HOSTNAME unset or Docker unreachable)",
      },
    };
  }

  // 4 + 5. Concurrent-update protection. SQLite single-writer makes
  // the check + insert effectively atomic for a single moor process.
  // Cross-process concurrency isn't a concern (moor is single-instance).
  if (hasInProgressAudit()) {
    return { ok: false, error: { code: "already_in_progress" } };
  }
  const auditId = insertAuditInProgress({
    from_digest: current.repo_digest,
    to_digest: targetDigest,
    prev_image_id: current.image_id,
  });

  // 6. Enable drain. NO `clear_after_version` — the success marker is
  // the authoritative event for drain-clear during an update_apply
  // flow. See design comment on #80 for the rationale (rolled_back with
  // matching version would clear drain prematurely).
  enableDrain({ reason: DRAIN_REASON(auditId), ttl_minutes: DRAIN_TTL_MIN });

  const failAndReturn = (error: ApplyError, errorLog: string): ApplyResult => {
    finalizeAudit(auditId, "failed", { error_log: errorLog });
    disableDrain();
    return { ok: false, error };
  };

  // 7. Re-check active work AFTER drain — closes the race where new
  // work landed between preflight and drain-enable.
  const post = await deps.getStatus();
  const stillActive = post.active_work;
  const anyActive =
    stillActive.builds_in_flight +
      stillActive.execs_in_flight +
      stillActive.crons_in_flight +
      stillActive.terminals_open >
    0;
  if (anyActive && !bypass.has("active_work")) {
    return failAndReturn(
      { code: "race_active_work", counts: stillActive as unknown as Record<string, number> },
      `race: active work appeared after drain enable: ${JSON.stringify(stillActive)}`,
    );
  }

  // 8. Fresh DB backup. Mandatory; not bypassable.
  const dataDir = deps.resolveDataDir();
  let backupPath: string;
  try {
    const result = await deps.takeBackup(dataDir);
    backupPath = result.path;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return failAndReturn(
      { code: "backup_failed", reason },
      `fresh backup failed before respawner launch: ${reason}`,
    );
  }
  setBackupPath(auditId, backupPath);

  // 9 + 10. Write context + override into the shared data dir.
  const ctxPath = contextFilePath(dataDir, auditId);
  const overridePath = overrideFilePath(dataDir, auditId);
  try {
    const contextJson = buildUpdateContextJson({
      audit_id: auditId,
      target_digest: targetDigest,
      prev_image_id: current.image_id,
      service: labels.service,
      working_dir: labels.working_dir,
      config_files: labels.config_files,
      data_mount,
      network: default_network,
    });
    const overrideYaml = buildUpdateOverrideYaml(labels.service, targetDigest);
    deps.writeFile(ctxPath, contextJson);
    deps.writeFile(overridePath, overrideYaml);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return failAndReturn(
      { code: "respawner_launch_failed", reason },
      `failed to write context/override before launching respawner: ${reason}`,
    );
  }

  // 11. Launch respawner. Image tag is the RUNNING moor's version —
  // the contract is between this moor and the respawner it launches,
  // not the target version.
  const respawnerImage = `ghcr.io/caiopizzol/moor-respawner:${deps.runningVersion()}`;
  try {
    await deps.launchRespawner({
      audit_id: auditId,
      respawner_image: respawnerImage,
      working_dir: labels.working_dir,
      data_mount,
      network: default_network,
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return failAndReturn(
      { code: "respawner_launch_failed", reason },
      `respawner launch failed: ${reason}`,
    );
  }

  // 12. Return audit_id; respawner runs async, marker ingestion is on
  // the new moor's boot path + the PR #2 background poller.
  return { ok: true, audit_id: auditId };
}

// ---- Real Docker-socket launcher ------------------------------------
//
// Production implementation of RespawnerLauncher. Pull → create → start
// against the local Docker daemon. Tests stub this; routes call it.

async function dockerPullImage(image: string): Promise<void> {
  // Parse <registry>/<repo>:<tag> — split on the LAST ":" that comes
  // after the last "/" (host/port can contain colons, e.g. localhost:5000).
  const lastSlash = image.lastIndexOf("/");
  const lastColon = image.lastIndexOf(":");
  const hasTag = lastColon > lastSlash;
  const fromImage = hasTag ? image.slice(0, lastColon) : image;
  const tag = hasTag ? image.slice(lastColon + 1) : "latest";

  const url = `http://localhost/v1.44/images/create?fromImage=${encodeURIComponent(
    fromImage,
  )}&tag=${encodeURIComponent(tag)}`;
  const res = await fetch(url, {
    method: "POST",
    unix: SOCKET_PATH,
    // GHCR pulls can take a while on first cold pull; 2 min cap.
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    throw new Error(`pull ${image} failed: HTTP ${res.status} ${await res.text()}`);
  }
  // Docker streams one JSON object per line. Drain and inspect for errors.
  // Per-line parse is robust to malformed/extra lines.
  const text = await res.text();
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t) as {
        error?: string;
        errorDetail?: { message?: string };
      };
      if (obj.error || obj.errorDetail) {
        throw new Error(
          `pull ${image}: ${obj.error ?? obj.errorDetail?.message ?? "unknown error"}`,
        );
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith(`pull ${image}:`)) throw e;
      // ignore non-JSON progress lines
    }
  }
}

type DockerMount =
  | { Type: "bind"; Source: string; Target: string; ReadOnly: boolean }
  | { Type: "volume"; Source: string; Target: string; ReadOnly: boolean };

function buildMounts(opts: RespawnerLaunchOpts): DockerMount[] {
  const mounts: DockerMount[] = [
    // Docker socket — read-write because the respawner issues docker compose.
    {
      Type: "bind",
      Source: "/var/run/docker.sock",
      Target: "/var/run/docker.sock",
      ReadOnly: false,
    },
    // Compose working dir — read-only. Respawner reads .env + relative
    // refs; never writes here. Mounted at the SAME absolute path so
    // compose's path resolution works without rewriting anything.
    {
      Type: "bind",
      Source: opts.working_dir,
      Target: opts.working_dir,
      ReadOnly: true,
    },
  ];
  // Data mount — same shape as moor's. Read-write because the respawner
  // writes the result marker into it.
  if (opts.data_mount.type === "volume") {
    mounts.push({
      Type: "volume",
      Source: opts.data_mount.name,
      Target: opts.data_mount.destination,
      ReadOnly: false,
    });
  } else {
    mounts.push({
      Type: "bind",
      Source: opts.data_mount.source,
      Target: opts.data_mount.destination,
      ReadOnly: false,
    });
  }
  return mounts;
}

async function dockerCreateAndStart(opts: RespawnerLaunchOpts): Promise<string> {
  const body = {
    Image: opts.respawner_image,
    Cmd: ["apply"],
    Env: [`MOOR_AUDIT_ID=${opts.audit_id}`],
    HostConfig: {
      Mounts: buildMounts(opts),
      NetworkMode: opts.network,
      RestartPolicy: { Name: "no" },
      // AutoRemove: true — respawner writes its marker then exits.
      // We don't need to keep the container around; the audit row
      // + marker carry all the diagnostic info, and leaving it would
      // collide on a re-apply with the same audit_id (won't happen
      // because audit_id is auto-increment, but defense-in-depth).
      AutoRemove: true,
    },
  };

  const name = `moor-respawner-${opts.audit_id}`;
  const createRes = await fetch(
    `http://localhost/v1.44/containers/create?name=${encodeURIComponent(name)}`,
    {
      method: "POST",
      unix: SOCKET_PATH,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!createRes.ok) {
    throw new Error(`create ${name}: HTTP ${createRes.status} ${await createRes.text()}`);
  }
  const created = (await createRes.json()) as { Id: string };

  const startRes = await fetch(`http://localhost/v1.44/containers/${created.Id}/start`, {
    method: "POST",
    unix: SOCKET_PATH,
    signal: AbortSignal.timeout(10_000),
  });
  if (!startRes.ok) {
    throw new Error(
      `start ${created.Id.slice(0, 12)}: HTTP ${startRes.status} ${await startRes.text()}`,
    );
  }
  return created.Id;
}

/** Production launcher: pull → create → start. Throws with a precise
 *  message on each failure mode so the audit row's error_log explains
 *  which step failed and why. */
export const realLaunchRespawner: RespawnerLauncher = async (opts) => {
  await dockerPullImage(opts.respawner_image);
  await dockerCreateAndStart(opts);
};
