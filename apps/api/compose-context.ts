// #80 PR #1: discover the Compose context moor is running under, so a
// future moor_update_apply can launch a respawner with the right
// project/service/working_dir/config_files + the right data mount +
// attached to the right network.
//
// Two layers:
//   - PURE parsers + validators (label parsing, mount-record extraction,
//     network record extraction). Easy to unit-test without Docker.
//   - inspectSelf() — async wrapper that calls /containers/<self>/json
//     over the Docker socket (same pattern as update-status.ts) and
//     feeds the response into the pure layer.
//
// Scope intentionally stops at discovery. Actual respawner launch is
// PR #3-onwards. This PR does NOT verify that the discovered paths
// are bind-mountable — that requires a real container launch and
// belongs in moor_update_apply.

import { isAbsolute, resolve as resolvePath } from "node:path";

// Labels Compose sets on every service container. The first two are
// officially guaranteed by Docker docs; the second two are
// Compose-provided in practice but not formally documented as stable.
// We require all four for the moor updater to be safe to run.
export const REQUIRED_COMPOSE_LABELS = {
  project: "com.docker.compose.project",
  service: "com.docker.compose.service",
  workingDir: "com.docker.compose.project.working_dir",
  configFiles: "com.docker.compose.project.config_files",
} as const;

export type ComposeLabels = {
  project: string;
  service: string;
  working_dir: string;
  config_files: string[];
};

export type MountRecord =
  | { type: "volume"; name: string; source: string; destination: string }
  | { type: "bind"; source: string; destination: string };

export type ComposeContext = {
  labels: ComposeLabels;
  data_mount: MountRecord;
  default_network: string;
};

export type DiscoveryError = {
  reason:
    | "no_hostname"
    | "inspect_failed"
    | "missing_labels"
    | "invalid_working_dir"
    | "no_config_files"
    | "no_data_mount"
    | "no_network";
  message: string;
};

export type DiscoveryResult =
  | { ok: true; context: ComposeContext }
  | { ok: false; error: DiscoveryError };

/** Pure: parse the `config_files` label value. Compose joins the list
 *  with commas. Relative entries are resolved against working_dir.
 *  Returns [] when the input is empty. */
export function parseConfigFiles(raw: string | undefined | null, workingDir: string): string[] {
  if (!raw) return [];
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.map((p) => (isAbsolute(p) ? p : resolvePath(workingDir, p)));
}

/** Pure: extract + validate the four required Compose labels.
 *  Returns ok: false with the specific missing label in the message
 *  so the operator knows what to fix. */
export function parseLabels(
  labels: Record<string, string> | undefined | null,
): { ok: true; labels: ComposeLabels } | { ok: false; error: DiscoveryError } {
  const L = labels ?? {};
  const missing: string[] = [];
  const project = L[REQUIRED_COMPOSE_LABELS.project];
  const service = L[REQUIRED_COMPOSE_LABELS.service];
  const workingDir = L[REQUIRED_COMPOSE_LABELS.workingDir];
  const configRaw = L[REQUIRED_COMPOSE_LABELS.configFiles];
  if (!project) missing.push(REQUIRED_COMPOSE_LABELS.project);
  if (!service) missing.push(REQUIRED_COMPOSE_LABELS.service);
  if (!workingDir) missing.push(REQUIRED_COMPOSE_LABELS.workingDir);
  if (!configRaw) missing.push(REQUIRED_COMPOSE_LABELS.configFiles);
  if (missing.length > 0) {
    return {
      ok: false,
      error: {
        reason: "missing_labels",
        message: `missing required Compose labels: ${missing.join(", ")}`,
      },
    };
  }
  if (!isAbsolute(workingDir)) {
    return {
      ok: false,
      error: {
        reason: "invalid_working_dir",
        message: `working_dir must be an absolute path, got: ${workingDir}`,
      },
    };
  }
  const configFiles = parseConfigFiles(configRaw, workingDir);
  if (configFiles.length === 0) {
    return {
      ok: false,
      error: { reason: "no_config_files", message: "config_files label is empty after parsing" },
    };
  }
  return {
    ok: true,
    labels: {
      project,
      service,
      working_dir: workingDir,
      config_files: configFiles,
    },
  };
}

type RawMount = {
  Type?: string;
  Name?: string;
  Source?: string;
  Destination?: string;
};

/** Pure: find the mount whose Destination matches the moor data path
 *  and return a structured record. Differentiates volume (mount by
 *  name) from bind (mount by source path) so the respawner can
 *  reproduce the mount cleanly. */
export function findDataMount(
  mounts: RawMount[] | undefined | null,
  destination = "/app/data",
): { ok: true; mount: MountRecord } | { ok: false; error: DiscoveryError } {
  const list = mounts ?? [];
  const m = list.find((x) => x.Destination === destination);
  if (!m) {
    return {
      ok: false,
      error: {
        reason: "no_data_mount",
        message: `no mount found at destination ${destination}; respawner cannot share data volume`,
      },
    };
  }
  if (!m.Source) {
    return {
      ok: false,
      error: { reason: "no_data_mount", message: `mount at ${destination} has no Source field` },
    };
  }
  if (m.Type === "volume") {
    if (!m.Name) {
      return {
        ok: false,
        error: {
          reason: "no_data_mount",
          message: `volume mount at ${destination} has no Name field; cannot mount by name`,
        },
      };
    }
    return { ok: true, mount: { type: "volume", name: m.Name, source: m.Source, destination } };
  }
  if (m.Type === "bind") {
    return { ok: true, mount: { type: "bind", source: m.Source, destination } };
  }
  return {
    ok: false,
    error: {
      reason: "no_data_mount",
      message: `mount at ${destination} has unsupported type=${m.Type ?? "unknown"}`,
    },
  };
}

/** Pure: pick the network the respawner should attach to. Compose
 *  creates `<project>_default` per project, but a service can be on
 *  additional named networks too. Preference order:
 *    1. `<project>_default` when present (canonical compose default).
 *    2. First key as fallback (single-network installs).
 *  Returns ok:false when the map is empty or missing.
 *
 *  `project` is optional so older callers (and existing tests) keep
 *  working; the update-apply path passes it. */
export function findDefaultNetwork(
  networks: Record<string, unknown> | undefined | null,
  project?: string,
): { ok: true; name: string } | { ok: false; error: DiscoveryError } {
  const keys = networks ? Object.keys(networks) : [];
  if (keys.length === 0) {
    return {
      ok: false,
      error: {
        reason: "no_network",
        message: "container has no NetworkSettings.Networks entries; cannot attach respawner",
      },
    };
  }
  if (project) {
    const preferred = `${project}_default`;
    if (keys.includes(preferred)) return { ok: true, name: preferred };
  }
  return { ok: true, name: keys[0] };
}

/** Pure: top-level composition of the three parsers against a raw
 *  Docker inspect payload. Exported separately from inspectSelf so
 *  tests can feed canned payloads. */
export function buildContextFromInspect(payload: {
  Config?: { Labels?: Record<string, string> | null };
  Mounts?: RawMount[];
  NetworkSettings?: { Networks?: Record<string, unknown> | null };
}): DiscoveryResult {
  const labels = parseLabels(payload.Config?.Labels);
  if (!labels.ok) return { ok: false, error: labels.error };
  const mount = findDataMount(payload.Mounts);
  if (!mount.ok) return { ok: false, error: mount.error };
  // Pass project so findDefaultNetwork can prefer `<project>_default`
  // over an arbitrary first key when moor is on multiple networks.
  const network = findDefaultNetwork(payload.NetworkSettings?.Networks, labels.labels.project);
  if (!network.ok) return { ok: false, error: network.error };
  return {
    ok: true,
    context: { labels: labels.labels, data_mount: mount.mount, default_network: network.name },
  };
}

/** Inject for tests. Returns the raw self-inspect payload or an
 *  error string. Never throws — discovery is best-effort and
 *  callers decide how to react. */
export type SelfInspector = () => Promise<
  | { ok: true; payload: Parameters<typeof buildContextFromInspect>[0] }
  | { ok: false; message: string }
>;

import { SOCKET as SOCKET_PATH } from "./docker";

export const realSelfInspect: SelfInspector = async () => {
  const hostname = process.env.HOSTNAME;
  if (!hostname) return { ok: false, message: "HOSTNAME env var unset" };
  try {
    const res = await fetch(`http://localhost/v1.44/containers/${hostname}/json`, {
      unix: SOCKET_PATH,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { ok: false, message: `docker inspect -> ${res.status}` };
    const payload = (await res.json()) as Parameters<typeof buildContextFromInspect>[0];
    return { ok: true, payload };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
};

/** Top-level discovery used by moor_update_apply. Calls the
 *  injectable self-inspector, then runs the pure pipeline. */
export async function discoverComposeContext(
  inspector: SelfInspector = realSelfInspect,
): Promise<DiscoveryResult> {
  const r = await inspector();
  if (!r.ok) {
    if (r.message === "HOSTNAME env var unset") {
      return { ok: false, error: { reason: "no_hostname", message: r.message } };
    }
    return { ok: false, error: { reason: "inspect_failed", message: r.message } };
  }
  return buildContextFromInspect(r.payload);
}
