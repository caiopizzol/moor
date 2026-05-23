// Raw host capacity used by #36 to validate per-project resource limits.
// Kept separate from routes/server.ts (which formats values like "7.8 GB" for
// the admin UI) so we can compare bytes/cores numerically. Docker doesn't
// rewrite /proc for cgroup limits by default, so os.totalmem() and
// os.cpus().length report the host's physical capacity even when moor itself
// runs inside a memory- or cpu-capped container — that's the right reference
// for validating limits we'll later apply to OTHER containers via the Docker
// socket, which sees the same host.

import { cpus, totalmem } from "node:os";

let cached: { totalMemoryBytes: number; cpuCores: number } | null = null;

export function getHostInfo(): { totalMemoryBytes: number; cpuCores: number } {
  if (!cached) {
    cached = { totalMemoryBytes: totalmem(), cpuCores: cpus().length };
  }
  return cached;
}

// Convenience for validation — host total in whole MiB, rounded down.
export function hostTotalMemoryMb(): number {
  return Math.floor(getHostInfo().totalMemoryBytes / (1024 * 1024));
}
