// #35: per-project named volume mounts. Centralized validation and the
// docker_name generator. The route handlers call into these so all writes go
// through the same rules.

// Docker volume name regex per the engine: [a-zA-Z0-9][a-zA-Z0-9_.-]*, max
// 255 chars. We use a tighter subset for the logical per-project name and
// add the moor- prefix at storage time. The generated docker_name is what
// actually goes to Docker.
export const MAX_VOLUME_NAME_LENGTH = 64;
export const MAX_DOCKER_NAME_LENGTH = 255;

const VOLUME_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

// Reject paths that would mount over critical container surfaces. Tight list
// to avoid blocking legitimate cases (e.g. mounting under /etc/myapp). The
// listed entries cover "the whole rootfs" and the kernel virtual filesystems
// that don't accept overlays sanely.
const FORBIDDEN_TARGETS_EXACT = new Set(["/", "/proc", "/sys", "/dev"]);
const FORBIDDEN_TARGET_PREFIXES = ["/proc/", "/sys/", "/dev/"];

export function validateVolumeName(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return "volume name is required";
  }
  if (value.length > MAX_VOLUME_NAME_LENGTH) {
    return `volume name must be <= ${MAX_VOLUME_NAME_LENGTH} characters`;
  }
  if (!VOLUME_NAME_RE.test(value)) {
    return "volume name must start alphanumeric; allowed chars: a-z A-Z 0-9 _ -";
  }
  return null;
}

export function validateVolumeTarget(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return "volume target path is required";
  }
  if (!value.startsWith("/")) {
    return "volume target must be an absolute path (starting with /)";
  }
  if (/\s/.test(value)) {
    return "volume target must not contain whitespace";
  }
  // Path-traversal guard. Normalizing in JS is awkward; the simplest correct
  // check is "no .. component anywhere."
  if (value.split("/").some((seg) => seg === "..")) {
    return "volume target must not contain '..'";
  }
  if (FORBIDDEN_TARGETS_EXACT.has(value)) {
    return `volume target ${value} is not allowed (would mount over a critical container surface)`;
  }
  for (const prefix of FORBIDDEN_TARGET_PREFIXES) {
    if (value === prefix || value.startsWith(prefix)) {
      return `volume target ${value} is not allowed (under ${prefix})`;
    }
  }
  return null;
}

/** Build the Docker volume name from project and logical handle. Stored once
 *  at config creation and reused forever — see schema comment for why. */
export function buildDockerName(projectName: string, volumeName: string): string {
  return `moor-${projectName}-${volumeName}`;
}

export function validateDockerName(dockerName: string): string | null {
  if (dockerName.length > MAX_DOCKER_NAME_LENGTH) {
    return `generated Docker volume name "${dockerName}" exceeds ${MAX_DOCKER_NAME_LENGTH} characters; use a shorter project or volume name`;
  }
  return null;
}
