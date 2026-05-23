// Validation for per-project resource limits (#36). Centralized so route
// handlers and tests share the same rules.

import { getHostInfo, hostTotalMemoryMb } from "./host-info";

// Docker's minimum memory limit. Below ~4 MiB the kernel refuses; 6 MiB is a
// safe practical floor and matches Docker CLI's documented minimum.
export const MIN_MEMORY_LIMIT_MB = 6;

// Practical CPU floor. cpus is multiplied by 1e9 and rounded for Docker's
// NanoCpus field, and Docker treats NanoCpus=0 as "unlimited" — so values
// small enough to round to zero would silently mean the opposite of what the
// operator asked for. 0.001 cores (one CPU-thousandth, NanoCpus=1_000_000) is
// well above the round-to-zero boundary and below anything an operator would
// reasonably need; finer-grained values are best expressed as "unlimited"
// (null) anyway.
export const MIN_CPUS = 0.001;

/** Result is null when value is valid; otherwise a 400-suitable error string. */
export function validateMemoryLimitMb(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return "memory_limit_mb must be an integer or null";
  }
  if (value < MIN_MEMORY_LIMIT_MB) {
    return `memory_limit_mb must be >= ${MIN_MEMORY_LIMIT_MB} (Docker's minimum)`;
  }
  const max = hostTotalMemoryMb();
  if (max > 0 && value > max) {
    return `memory_limit_mb (${value}) exceeds host total memory (${max} MB)`;
  }
  return null;
}

/** Result is null when value is valid; otherwise a 400-suitable error string. */
export function validateCpus(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "cpus must be a number or null";
  }
  if (value <= 0) return "cpus must be > 0 (use null to clear)";
  if (value < MIN_CPUS) {
    return `cpus must be >= ${MIN_CPUS} (values smaller than this round to Docker NanoCpus=0, which means unlimited; use null to clear)`;
  }
  const max = getHostInfo().cpuCores;
  if (max > 0 && value > max) {
    return `cpus (${value}) exceeds host core count (${max})`;
  }
  return null;
}
