// #78: pre-update visibility. Reports moor's current version, the
// latest available image on GHCR (if reachable), in-flight work
// counts, DB backup recency, and a safe_to_update boolean with a
// human-readable reasons array.
//
// Design notes (locked in the issue body):
// - DON'T collapse Docker identity into one field. image_id and
//   repo_digest are different identifier spaces; only repo_digest can
//   be compared against the registry digest. If either side is
//   unknown, update_available is null (not false).
// - safe_to_update is sugar for unsafe_reasons.length === 0. The
//   array IS the contract; consumers should render it inline.
// - db_backup is sourced from db-backup.ts (#90). When no snapshot
//   exists, age_seconds is null and unsafe_reasons points operators
//   at moor_db_backup / MOOR_DB_BACKUP_INTERVAL_HOURS so the absence
//   is actionable, not a dead-end.
// - Terminal count: project terminals only in v1. Host terminals
//   aren't tracked; documented as a known limitation.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import db from "./db";
import { getLatestBackupInfo } from "./db-backup";
import { SOCKET as SOCKET_PATH } from "./docker";
import { getActiveSessionCount } from "./terminal-sessions";

export type UpdateStatusResponse = {
  current: {
    version: string;
    image_id: string | null;
    repo_digest: string | null;
    started_at: string;
  };
  available: {
    latest_tag: string;
    latest_digest: string | null;
    update_available: boolean | null;
    registry_error: string | null;
  };
  active_work: {
    builds_in_flight: number;
    execs_in_flight: number;
    crons_in_flight: number;
    terminals_open: number;
  };
  db_backup: {
    last_backup_at: string | null;
    age_seconds: number | null;
    location: string | null;
  };
  safe_to_update: boolean;
  unsafe_reasons: string[];
  recommended_command: string;
};

const RECOMMENDED_COMMAND =
  "docker compose pull moor && docker compose up -d --no-deps --wait moor";

const BACKUP_MAX_AGE_SECONDS = 24 * 60 * 60;

const REPO = "caiopizzol/moor";
const LATEST_TAG = "latest";

/** Pure: pick the first registry-comparable RepoDigest from a Docker
 *  image inspect. Filters to entries that contain "@sha256:" (the
 *  digest form). Returns null when none qualify (locally-built image
 *  or stale inspect). */
export function extractRepoDigest(repoDigests: string[] | null | undefined): string | null {
  if (!repoDigests || repoDigests.length === 0) return null;
  for (const d of repoDigests) {
    if (typeof d === "string" && d.includes("@sha256:")) return d;
  }
  return null;
}

/** Pure: compare current repo digest against the registry's latest
 *  digest. Returns null when either side is unknown — never lies by
 *  comparing across identifier spaces. */
export function compareForUpdate(
  currentRepoDigest: string | null,
  latestDigest: string | null,
): boolean | null {
  if (!currentRepoDigest || !latestDigest) return null;
  // Extract just the sha256:... portion from `repo@sha256:...` if needed.
  const currentSha = currentRepoDigest.includes("@")
    ? currentRepoDigest.split("@")[1]
    : currentRepoDigest;
  const latestSha = latestDigest.includes("@") ? latestDigest.split("@")[1] : latestDigest;
  return currentSha !== latestSha;
}

/** Pure: build the human-readable list of reasons why an update is
 *  unsafe right now. Empty array means safe. The boolean
 *  `safe_to_update` is sugar for length === 0. */
export function buildUnsafeReasons(input: {
  builds_in_flight: number;
  execs_in_flight: number;
  crons_in_flight: number;
  terminals_open: number;
  backup_age_seconds: number | null;
}): string[] {
  const reasons: string[] = [];
  if (input.builds_in_flight > 0) {
    reasons.push(`${input.builds_in_flight} build/pull in flight`);
  }
  if (input.execs_in_flight > 0) {
    reasons.push(`${input.execs_in_flight} async exec in flight`);
  }
  if (input.crons_in_flight > 0) {
    reasons.push(`${input.crons_in_flight} cron run in flight`);
  }
  if (input.terminals_open > 0) {
    reasons.push(`${input.terminals_open} project terminal(s) open`);
  }
  if (input.backup_age_seconds === null) {
    reasons.push(
      "no recent DB backup (run moor_db_backup or set MOOR_DB_BACKUP_INTERVAL_HOURS; see #90)",
    );
  } else if (input.backup_age_seconds > BACKUP_MAX_AGE_SECONDS) {
    const hours = Math.round(input.backup_age_seconds / 3600);
    reasons.push(`last backup ${hours}h ago (older than 24h)`);
  }
  return reasons;
}

/** Read moor's release version from the root package.json shipped in
 *  the image. The root package.json (not apps/api/package.json) is the
 *  one bumped by semantic-release and tracks the published image tag.
 *  Falls back to "unknown" on any failure — don't block on this. */
export function readPackageVersion(): string {
  try {
    const path = join(import.meta.dir, "..", "..", "package.json");
    const json = JSON.parse(readFileSync(path, "utf-8")) as { version?: string };
    return json.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

async function dockerJson<T>(path: string): Promise<T> {
  const res = await fetch(`http://localhost${path}`, {
    unix: SOCKET_PATH,
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`docker ${path} -> ${res.status}`);
  return (await res.json()) as T;
}

type ContainerInspect = {
  Image: string;
  State: { StartedAt: string };
};

type ImageInspect = {
  RepoDigests?: string[];
};

export async function getCurrentImageInfo(): Promise<{
  image_id: string | null;
  repo_digest: string | null;
  started_at: string;
}> {
  const hostname = process.env.HOSTNAME;
  if (!hostname) {
    return { image_id: null, repo_digest: null, started_at: "" };
  }
  try {
    const container = await dockerJson<ContainerInspect>(`/v1.44/containers/${hostname}/json`);
    const imageId = container.Image;
    const startedAt = container.State?.StartedAt ?? "";
    try {
      const image = await dockerJson<ImageInspect>(`/v1.44/images/${imageId}/json`);
      return {
        image_id: imageId,
        repo_digest: extractRepoDigest(image.RepoDigests),
        started_at: startedAt,
      };
    } catch {
      return { image_id: imageId, repo_digest: null, started_at: startedAt };
    }
  } catch {
    return { image_id: null, repo_digest: null, started_at: "" };
  }
}

/** Inject for tests. Returns the GHCR latest manifest digest, or an
 *  error string. Never throws — the route shouldn't fail because the
 *  registry is unreachable.
 *
 *  Anonymous token flow:
 *  1. GET https://ghcr.io/token?scope=repository:<repo>:pull → { token }
 *  2. GET https://ghcr.io/v2/<repo>/manifests/<tag> with Bearer token
 *     and the right Accept headers → Docker-Content-Digest response header
 *
 *  See the issue body for the full rationale. */
export type GhcrFetcher = () => Promise<
  { ok: true; digest: string } | { ok: false; error: string }
>;

export const realGhcrFetch: GhcrFetcher = async () => {
  try {
    const tokenRes = await fetch(`https://ghcr.io/token?scope=repository:${REPO}:pull`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!tokenRes.ok) return { ok: false, error: `token: ${tokenRes.status}` };
    const { token } = (await tokenRes.json()) as { token?: string };
    if (!token) return { ok: false, error: "token response missing 'token' field" };

    const manifestRes = await fetch(`https://ghcr.io/v2/${REPO}/manifests/${LATEST_TAG}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: [
          "application/vnd.oci.image.index.v1+json",
          "application/vnd.oci.image.manifest.v1+json",
          "application/vnd.docker.distribution.manifest.v2+json",
          "application/vnd.docker.distribution.manifest.list.v2+json",
        ].join(", "),
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!manifestRes.ok) return { ok: false, error: `manifest: ${manifestRes.status}` };
    const digest = manifestRes.headers.get("docker-content-digest");
    if (!digest)
      return { ok: false, error: "manifest response missing Docker-Content-Digest header" };
    return { ok: true, digest };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
};

export function getActiveWorkCounts(): UpdateStatusResponse["active_work"] {
  const builds = db
    .query("SELECT COUNT(*) as n FROM runs WHERE finished_at IS NULL AND cron_id IS NULL")
    .get() as { n: number };
  const crons = db
    .query("SELECT COUNT(*) as n FROM runs WHERE finished_at IS NULL AND cron_id IS NOT NULL")
    .get() as { n: number };
  const execs = db.query("SELECT COUNT(*) as n FROM exec_runs WHERE state = 'running'").get() as {
    n: number;
  };
  // Project terminals only in v1 — host terminals (host-terminal.ts)
  // aren't tracked by this map and aren't counted. Documented in the
  // issue body.
  return {
    builds_in_flight: builds.n,
    execs_in_flight: execs.n,
    crons_in_flight: crons.n,
    terminals_open: getActiveSessionCount(),
  };
}

export function getDbBackupInfo(): UpdateStatusResponse["db_backup"] {
  // #90: backed by db-backup.ts. Returns the freshness of the most
  // recent VACUUM INTO snapshot in the backup directory, or the
  // documented null shape when no snapshot exists.
  return getLatestBackupInfo();
}

export async function buildUpdateStatus(
  ghcrFetch: GhcrFetcher = realGhcrFetch,
): Promise<UpdateStatusResponse> {
  const version = readPackageVersion();
  const [imageInfo, ghcr] = await Promise.all([getCurrentImageInfo(), ghcrFetch()]);
  const activeWork = getActiveWorkCounts();
  const backup = getDbBackupInfo();

  const latestDigest = ghcr.ok ? ghcr.digest : null;
  const registryError = ghcr.ok ? null : ghcr.error;

  const unsafe_reasons = buildUnsafeReasons({
    ...activeWork,
    backup_age_seconds: backup.age_seconds,
  });

  return {
    current: {
      version,
      image_id: imageInfo.image_id,
      repo_digest: imageInfo.repo_digest,
      started_at: imageInfo.started_at,
    },
    available: {
      latest_tag: LATEST_TAG,
      latest_digest: latestDigest,
      update_available: compareForUpdate(imageInfo.repo_digest, latestDigest),
      registry_error: registryError,
    },
    active_work: activeWork,
    db_backup: backup,
    safe_to_update: unsafe_reasons.length === 0,
    unsafe_reasons,
    recommended_command: RECOMMENDED_COMMAND,
  };
}
