// Must stay in lockstep with the API's check (apps/api/github-url.ts): https only,
// hostname exactly github.com or www.github.com. Anything looser passes client
// validation but is rejected by the API at build time.
export function validateGithubUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`github_url is not a valid URL: ${url}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`github_url must use https (got protocol "${parsed.protocol}")`);
  }
  const host = parsed.hostname;
  if (host !== "github.com" && host !== "www.github.com") {
    throw new Error(`github_url must use github.com or www.github.com (got "${host}")`);
  }
}

export function validateGithubRepoUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`github_url is not a valid URL: ${url}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`github_url must use https (got protocol "${parsed.protocol}")`);
  }
  if (parsed.search) {
    throw new Error(`github_url must not contain query parameters (got "${parsed.search}")`);
  }
  if (parsed.hash) {
    throw new Error(`github_url must not contain a URL fragment (got "${parsed.hash}")`);
  }
  const host = parsed.hostname;
  if (host !== "github.com" && host !== "www.github.com") {
    throw new Error(`github_url must use github.com or www.github.com (got "${host}")`);
  }
  if (!/^\/[^/]+\/[^/]+?(\.git)?\/?$/.test(parsed.pathname)) {
    throw new Error(
      `github_url must point to /owner/repo (with optional .git); got "${parsed.pathname}"`,
    );
  }
}

const CRON_FIELDS: ReadonlyArray<{ name: string; min: number; max: number }> = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day-of-week", min: 0, max: 6 },
];

const CRON_PART_PATTERNS = [
  /^\*$/,
  /^(\d+)$/,
  /^(\d+)-(\d+)$/,
  /^\*\/(\d+)$/,
  /^(\d+)-(\d+)\/(\d+)$/,
];

export const CRON_TIMEOUT_DEFAULT_MS = 600_000;
export const CRON_TIMEOUT_MIN_MS = 60_000;
export const CRON_TIMEOUT_MAX_MS = 604_800_000;

export function validateCronTimeoutMs(value: unknown): string | null {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < CRON_TIMEOUT_MIN_MS ||
    value > CRON_TIMEOUT_MAX_MS
  ) {
    return `timeout_ms must be an integer between ${CRON_TIMEOUT_MIN_MS} and ${CRON_TIMEOUT_MAX_MS}`;
  }
  return null;
}

export function validateCronSchedule(schedule: string): string | null {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) {
    return `schedule must have exactly 5 space-separated fields (got ${parts.length})`;
  }
  for (let i = 0; i < 5; i++) {
    const field = CRON_FIELDS[i];
    const err = validateCronField(parts[i], field.min, field.max, field.name);
    if (err) return err;
  }
  return null;
}

function validateCronField(field: string, min: number, max: number, name: string): string | null {
  if (field === "*") return null;
  if (/[?LW#]/i.test(field)) return `${name}: ?, L, W, # are not supported`;
  if (/[a-zA-Z]/.test(field)) {
    return `${name}: month/day names are not supported, use numeric values`;
  }

  for (const part of field.split(",")) {
    if (part === "") return `${name}: empty list element`;

    const match = CRON_PART_PATTERNS.map((re) => part.match(re)).find((m) => m !== null);
    if (!match) return `${name}: invalid expression "${part}"`;

    const groups = match.slice(1);
    if (groups.length === 1 && match[0].startsWith("*/")) {
      const step = Number(groups[0]);
      if (step <= 0) return `${name}: step must be a positive integer (got "${groups[0]}")`;
    } else if (groups.length === 1) {
      const n = Number(groups[0]);
      if (n < min || n > max) return `${name}: ${n} out of bounds [${min}-${max}]`;
    } else if (groups.length === 2) {
      const a = Number(groups[0]);
      const b = Number(groups[1]);
      if (a < min || b > max) return `${name}: range ${a}-${b} out of bounds [${min}-${max}]`;
      if (a > b) return `${name}: range ${a}-${b} is descending`;
    } else if (groups.length === 3) {
      const a = Number(groups[0]);
      const b = Number(groups[1]);
      const step = Number(groups[2]);
      if (a < min || b > max) return `${name}: range ${a}-${b} out of bounds [${min}-${max}]`;
      if (a > b) return `${name}: range ${a}-${b} is descending`;
      if (step <= 0) return `${name}: step must be a positive integer (got "${groups[2]}")`;
    }
  }
  return null;
}
