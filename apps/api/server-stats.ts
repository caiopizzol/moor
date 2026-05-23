// Pure helpers for /api/server/stats. Kept separate from the route so they're
// trivially testable without execSync or the docker socket.

export type LoadInfo = {
  one_min: number;
  cores: number;
  normalized_percent: number;
};

export type DockerDiskCategory = {
  bytes: number;
  reclaimable_bytes: number;
  count: number;
  unused_count: number;
};

export type DockerDisk = {
  images: DockerDiskCategory;
  containers: DockerDiskCategory & { stopped_count: number };
  volumes: DockerDiskCategory;
  build_cache: { bytes: number; reclaimable_bytes: number; count: number };
};

export type SystemDfResponse = {
  LayersSize?: number;
  Images?: Array<{ Id: string; Size: number; SharedSize: number; Containers: number }> | null;
  Containers?: Array<{
    Id: string;
    SizeRw?: number;
    SizeRootFs?: number;
    State: string;
  }> | null;
  Volumes?: Array<{
    Name: string;
    UsageData?: { Size: number; RefCount: number } | null;
  }> | null;
  BuildCache?: Array<{ ID: string; Size: number; InUse: boolean; Shared: boolean }> | null;
};

/** Same formula `cpu.percent` uses today: load1m ÷ cores, clamped to 100. */
export function computeLoadPercent(load1m: number, cores: number): number {
  if (!Number.isFinite(load1m) || cores <= 0) return 0;
  return Math.min(100, Math.round((load1m / cores) * 100));
}

/** Parse `/proc/loadavg` first field; returns NaN if the input is empty/malformed. */
export function parseLoadAvg(raw: string): number {
  const first = raw.split(/\s+/)[0];
  return Number.parseFloat(first);
}

/** Aggregate Docker `/system/df` into compact per-category numbers.
 *
 *  Notes:
 *  - Images: `Size - SharedSize` is the bytes a delete would actually free
 *    (shared layers stay live). Reclaimable counts only images with zero
 *    container refs, matching `docker system df`'s ACTIVE/RECLAIMABLE split.
 *  - Containers: `SizeRw` is the writable layer. Reclaimable counts only
 *    non-running containers, since a running container's writable layer
 *    can't be removed.
 *  - Volumes: `UsageData.Size` is -1 when Docker didn't walk the volume.
 *    Treat -1 as 0 for sums so a single un-walked volume can't dominate.
 *  - Build cache: every entry is technically prunable, but we only count
 *    `!InUse` rows toward reclaimable to match the conservative posture
 *    expected by cleanup tooling.
 */
export function parseSystemDf(raw: SystemDfResponse): DockerDisk {
  const images = raw.Images ?? [];
  const containers = raw.Containers ?? [];
  const volumes = raw.Volumes ?? [];
  const buildCache = raw.BuildCache ?? [];

  let imagesBytes = 0;
  let imagesReclaimable = 0;
  let imagesUnused = 0;
  for (const img of images) {
    const unique = Math.max(0, (img.Size ?? 0) - (img.SharedSize ?? 0));
    imagesBytes += unique;
    if ((img.Containers ?? 0) === 0) {
      imagesReclaimable += unique;
      imagesUnused++;
    }
  }

  let containersBytes = 0;
  let containersReclaimable = 0;
  let containersStopped = 0;
  for (const c of containers) {
    const rw = c.SizeRw ?? 0;
    containersBytes += rw;
    if (c.State !== "running") {
      containersReclaimable += rw;
      containersStopped++;
    }
  }

  let volumesBytes = 0;
  let volumesReclaimable = 0;
  let volumesUnused = 0;
  for (const v of volumes) {
    const size = v.UsageData?.Size ?? -1;
    const safeSize = size < 0 ? 0 : size;
    volumesBytes += safeSize;
    const refCount = v.UsageData?.RefCount ?? 0;
    if (refCount === 0) {
      volumesReclaimable += safeSize;
      volumesUnused++;
    }
  }

  let cacheBytes = 0;
  let cacheReclaimable = 0;
  for (const entry of buildCache) {
    const size = entry.Size ?? 0;
    cacheBytes += size;
    if (!entry.InUse) cacheReclaimable += size;
  }

  return {
    images: {
      bytes: imagesBytes,
      reclaimable_bytes: imagesReclaimable,
      count: images.length,
      unused_count: imagesUnused,
    },
    containers: {
      bytes: containersBytes,
      reclaimable_bytes: containersReclaimable,
      count: containers.length,
      unused_count: containersStopped,
      stopped_count: containersStopped,
    },
    volumes: {
      bytes: volumesBytes,
      reclaimable_bytes: volumesReclaimable,
      count: volumes.length,
      unused_count: volumesUnused,
    },
    build_cache: {
      bytes: cacheBytes,
      reclaimable_bytes: cacheReclaimable,
      count: buildCache.length,
    },
  };
}
