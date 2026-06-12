// Declarative container configuration that doesn't fit the volume/env/port
// model: command + entrypoint overrides, and injected files. Centralized
// validation and (de)serialization so every write goes through the same rules,
// mirroring apps/api/volumes.ts.

// --- command / entrypoint override ---

export const MAX_ARGV_ITEMS = 256;
export const MAX_ARGV_ITEM_LENGTH = 4096;

/** Validate a command/entrypoint override: an array of strings, or null/omitted
 *  to mean "use the image default". `field` names the field in the message.
 *  Returns an error string or null. */
export function validateStringArray(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) return `${field} must be an array of strings`;
  if (value.length > MAX_ARGV_ITEMS) return `${field} must have at most ${MAX_ARGV_ITEMS} items`;
  for (const item of value) {
    if (typeof item !== "string") return `${field} entries must all be strings`;
    if (item.length > MAX_ARGV_ITEM_LENGTH) {
      return `${field} entries must each be at most ${MAX_ARGV_ITEM_LENGTH} characters`;
    }
  }
  return null;
}

/** Turn a validated command/entrypoint value into the stored JSON form. An
 *  empty array is stored as NULL: Docker reads `Cmd: []` / `Entrypoint: []` as
 *  an explicit override that clears the image default, and absence of input
 *  should never trigger that. Pass null explicitly via the route to clear. */
export function serializeStringArray(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  return JSON.stringify(value);
}

/** Parse a stored command/entrypoint column back into an array. Tolerates NULL
 *  and malformed/legacy values (returns null) so a bad row can't crash a
 *  container start. */
export function parseStringArray(stored: string | null | undefined): string[] | null {
  if (!stored) return null;
  try {
    const parsed = JSON.parse(stored);
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string") && parsed.length > 0) {
      return parsed;
    }
  } catch {
    // malformed — treat as unset
  }
  return null;
}

// --- injected files ---

export type FileSpec = {
  id: number;
  path: string;
  content: string | null;
  env_ref: string | null;
  mode: string;
};

/** A file ready to write into a container: content already resolved (inline or
 *  from the referenced env var) and mode parsed from octal text to bits. */
export type ResolvedFile = { path: string; content: string; mode: number };

export const MAX_FILE_PATH_LENGTH = 255;
export const MAX_FILE_CONTENT_BYTES = 1024 * 1024; // 1 MiB inline cap
export const DEFAULT_FILE_MODE = "0644";

const FILE_MODE_RE = /^0?[0-7]{3,4}$/;

// Same posture as volume targets: refuse paths that would clobber the rootfs or
// a kernel virtual filesystem.
const FORBIDDEN_FILE_TARGETS_EXACT = new Set(["/", "/proc", "/sys", "/dev"]);
const FORBIDDEN_FILE_TARGET_PREFIXES = ["/proc/", "/sys/", "/dev/"];

export function validateFilePath(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return "file path is required";
  if (value.length > MAX_FILE_PATH_LENGTH) {
    return `file path must be at most ${MAX_FILE_PATH_LENGTH} characters`;
  }
  if (!value.startsWith("/")) return "file path must be absolute (starting with /)";
  if (value.endsWith("/")) return "file path must reference a file, not a directory";
  if (/\s/.test(value)) return "file path must not contain whitespace";
  // The tar writer encodes member names one byte per char; keep paths to
  // printable ASCII so a name can't be silently mangled.
  if (/[^!-~]/.test(value)) return "file path must be printable ASCII without spaces";
  if (value.split("/").some((seg) => seg === "..")) return "file path must not contain '..'";
  if (FORBIDDEN_FILE_TARGETS_EXACT.has(value)) {
    return `file path ${value} is not allowed (would overwrite a critical container surface)`;
  }
  for (const prefix of FORBIDDEN_FILE_TARGET_PREFIXES) {
    if (value === prefix || value.startsWith(prefix)) {
      return `file path ${value} is not allowed (under ${prefix})`;
    }
  }
  return null;
}

/** Validate the octal mode string. null/undefined is allowed (the caller
 *  applies DEFAULT_FILE_MODE). */
export function validateFileMode(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !FILE_MODE_RE.test(value)) {
    return "file mode must be an octal string like '0600', '600', or '0644'";
  }
  return null;
}

export function parseFileMode(mode: string): number {
  return Number.parseInt(mode, 8);
}

/** Validate the content side of a file spec: exactly one of inline `content`
 *  or `env_ref` (a project env var name to source the content from at create
 *  time, so a secret lives in the env store rather than plaintext here). */
export function validateFileContent(content: unknown, envRef: unknown): string | null {
  const hasContent = content !== undefined && content !== null;
  const hasEnvRef = envRef !== undefined && envRef !== null && envRef !== "";
  if (hasContent === hasEnvRef) {
    return "provide exactly one of content or env_ref";
  }
  if (hasContent) {
    if (typeof content !== "string") return "content must be a string";
    if (new TextEncoder().encode(content).length > MAX_FILE_CONTENT_BYTES) {
      return `content must be at most ${MAX_FILE_CONTENT_BYTES} bytes`;
    }
  }
  if (hasEnvRef && typeof envRef !== "string") return "env_ref must be a string";
  return null;
}

/** Resolve a file spec's content from inline text or the referenced env var.
 *  envVars is the project's env list (the existing secret store). Throws a
 *  clear error when an env_ref names a var that isn't set, so a misconfigured
 *  file fails the deploy loudly instead of writing empty/secretless content. */
export function resolveFileContent(
  spec: { path: string; content: string | null; env_ref: string | null },
  envVars: { key: string; value: string }[],
): string {
  if (spec.content !== null && spec.content !== undefined) return spec.content;
  if (spec.env_ref) {
    const match = envVars.find((e) => e.key === spec.env_ref);
    if (!match) {
      throw new Error(
        `file ${spec.path} references env var "${spec.env_ref}" but it is not set on the project`,
      );
    }
    return match.value;
  }
  return "";
}

/** Resolve a list of file specs into write-ready files (content + numeric
 *  mode). Pure: route handlers fetch specs + envs, this does the merge. */
export function resolveFiles(
  specs: FileSpec[],
  envVars: { key: string; value: string }[],
): ResolvedFile[] {
  return specs.map((spec) => ({
    path: spec.path,
    content: resolveFileContent(spec, envVars),
    mode: parseFileMode(spec.mode),
  }));
}
