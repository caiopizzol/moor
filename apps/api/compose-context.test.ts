// Tests for #80 PR #1 compose-context discovery. The pure parsers
// (parseLabels, parseConfigFiles, findDataMount, findDefaultNetwork,
// buildContextFromInspect) are unit-tested directly. discoverComposeContext
// is exercised with an injected SelfInspector — no Docker required.

import { describe, expect, test } from "bun:test";

import {
  buildContextFromInspect,
  discoverComposeContext,
  findDataMount,
  findDefaultNetwork,
  parseConfigFiles,
  parseLabels,
  REQUIRED_COMPOSE_LABELS,
} from "./compose-context";

describe("#80 PR #1 parseConfigFiles", () => {
  test("absolute paths pass through unchanged", () => {
    expect(parseConfigFiles("/a.yml,/b.yml", "/wd")).toEqual(["/a.yml", "/b.yml"]);
  });

  test("relative entries are resolved against working_dir", () => {
    expect(parseConfigFiles("docker-compose.yml,override.yml", "/root/moor")).toEqual([
      "/root/moor/docker-compose.yml",
      "/root/moor/override.yml",
    ]);
  });

  test("mix of absolute and relative resolves each appropriately", () => {
    expect(parseConfigFiles("/etc/compose/base.yml,site.yml", "/root/moor")).toEqual([
      "/etc/compose/base.yml",
      "/root/moor/site.yml",
    ]);
  });

  test("empty/null/undefined → []", () => {
    expect(parseConfigFiles(undefined, "/wd")).toEqual([]);
    expect(parseConfigFiles(null, "/wd")).toEqual([]);
    expect(parseConfigFiles("", "/wd")).toEqual([]);
  });

  test("whitespace and blank entries are tolerated", () => {
    expect(parseConfigFiles(" /a.yml , /b.yml , ", "/wd")).toEqual(["/a.yml", "/b.yml"]);
  });
});

describe("#80 PR #1 parseLabels", () => {
  const valid = {
    [REQUIRED_COMPOSE_LABELS.project]: "moor",
    [REQUIRED_COMPOSE_LABELS.service]: "moor",
    [REQUIRED_COMPOSE_LABELS.workingDir]: "/root/moor",
    [REQUIRED_COMPOSE_LABELS.configFiles]: "docker-compose.yml",
  };

  test("happy path with all four labels → ok with resolved config_files", () => {
    const r = parseLabels(valid);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.labels.project).toBe("moor");
    expect(r.labels.service).toBe("moor");
    expect(r.labels.working_dir).toBe("/root/moor");
    expect(r.labels.config_files).toEqual(["/root/moor/docker-compose.yml"]);
  });

  test("each missing label is named in the error message", () => {
    for (const key of Object.values(REQUIRED_COMPOSE_LABELS)) {
      const partial = { ...valid };
      delete (partial as Record<string, string>)[key];
      const r = parseLabels(partial);
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.error.reason).toBe("missing_labels");
      expect(r.error.message).toContain(key);
    }
  });

  test("null/undefined labels object → missing_labels", () => {
    expect(parseLabels(null).ok).toBe(false);
    expect(parseLabels(undefined).ok).toBe(false);
  });

  test("multiple missing labels are all listed in the message", () => {
    const r = parseLabels({ [REQUIRED_COMPOSE_LABELS.project]: "moor" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain(REQUIRED_COMPOSE_LABELS.service);
    expect(r.error.message).toContain(REQUIRED_COMPOSE_LABELS.workingDir);
    expect(r.error.message).toContain(REQUIRED_COMPOSE_LABELS.configFiles);
  });

  test("relative working_dir is rejected (we mount it at the same absolute path)", () => {
    const r = parseLabels({ ...valid, [REQUIRED_COMPOSE_LABELS.workingDir]: "moor" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.reason).toBe("invalid_working_dir");
  });

  test("config_files that parses to [] (only whitespace) → no_config_files", () => {
    const r = parseLabels({ ...valid, [REQUIRED_COMPOSE_LABELS.configFiles]: "  ,  ," });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.reason).toBe("no_config_files");
  });

  test("supports multiple config files (e.g. base + override)", () => {
    const r = parseLabels({
      ...valid,
      [REQUIRED_COMPOSE_LABELS.configFiles]: "docker-compose.yml,docker-compose.override.yml",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.labels.config_files).toEqual([
      "/root/moor/docker-compose.yml",
      "/root/moor/docker-compose.override.yml",
    ]);
  });
});

describe("#80 PR #1 findDataMount", () => {
  test("volume mount → returns by name", () => {
    const r = findDataMount([
      {
        Type: "volume",
        Name: "moor_moor-data",
        Source: "/var/lib/docker/volumes/moor_moor-data/_data",
        Destination: "/app/data",
      },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.mount).toEqual({
      type: "volume",
      name: "moor_moor-data",
      source: "/var/lib/docker/volumes/moor_moor-data/_data",
      destination: "/app/data",
    });
  });

  test("bind mount → returns by source path", () => {
    const r = findDataMount([{ Type: "bind", Source: "/srv/moor/data", Destination: "/app/data" }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.mount).toEqual({
      type: "bind",
      source: "/srv/moor/data",
      destination: "/app/data",
    });
  });

  test("no mount at /app/data → no_data_mount", () => {
    const r = findDataMount([{ Type: "bind", Source: "/x", Destination: "/y" }]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.reason).toBe("no_data_mount");
  });

  test("empty/null mounts → no_data_mount", () => {
    expect(findDataMount(null).ok).toBe(false);
    expect(findDataMount([]).ok).toBe(false);
  });

  test("volume mount without Name → error (cannot mount by name)", () => {
    const r = findDataMount([
      { Type: "volume", Source: "/var/lib/docker/...", Destination: "/app/data" },
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain("no Name");
  });

  test("unsupported type (tmpfs etc) → error so respawner doesn't guess", () => {
    const r = findDataMount([{ Type: "tmpfs", Source: "tmpfs", Destination: "/app/data" }]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain("unsupported type");
  });

  test("custom destination override (for tests with non-standard paths)", () => {
    const r = findDataMount([{ Type: "bind", Source: "/srv/moor", Destination: "/data" }], "/data");
    expect(r.ok).toBe(true);
  });
});

describe("#80 PR #1/#4 findDefaultNetwork", () => {
  test("picks the first network key when no project hint", () => {
    const r = findDefaultNetwork({ moor_default: { IPAddress: "172.18.0.2" } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.name).toBe("moor_default");
  });

  test("empty/null networks → no_network", () => {
    expect(findDefaultNetwork(null).ok).toBe(false);
    expect(findDefaultNetwork({}).ok).toBe(false);
  });

  test("#80 PR #4: prefers `<project>_default` when present and project is passed", () => {
    const r = findDefaultNetwork({ some_other_net: {}, moor_default: {}, another: {} }, "moor");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.name).toBe("moor_default");
  });

  test("#80 PR #4: falls back to first key when `<project>_default` isn't present", () => {
    const r = findDefaultNetwork({ custom_network: {}, another: {} }, "moor");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.name).toBe("custom_network");
  });

  test("#80 PR #4: project hint is opt-in — older calls without it behave like before", () => {
    const r = findDefaultNetwork({ alpha: {}, beta_default: {} });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.name).toBe("alpha"); // no project → first key, NOT beta_default
  });
});

describe("#80 PR #1 buildContextFromInspect (pipeline)", () => {
  const goodPayload = {
    Config: {
      Labels: {
        [REQUIRED_COMPOSE_LABELS.project]: "moor",
        [REQUIRED_COMPOSE_LABELS.service]: "moor",
        [REQUIRED_COMPOSE_LABELS.workingDir]: "/root/moor",
        [REQUIRED_COMPOSE_LABELS.configFiles]: "docker-compose.yml",
      },
    },
    Mounts: [
      {
        Type: "volume",
        Name: "moor_moor-data",
        Source: "/var/lib/docker/volumes/moor_moor-data/_data",
        Destination: "/app/data",
      },
    ],
    NetworkSettings: { Networks: { moor_default: {} } },
  };

  test("end-to-end happy path produces a full ComposeContext", () => {
    const r = buildContextFromInspect(goodPayload);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.context.labels.service).toBe("moor");
    expect(r.context.data_mount.type).toBe("volume");
    expect(r.context.default_network).toBe("moor_default");
  });

  test("missing labels short-circuit before mount/network checks", () => {
    const r = buildContextFromInspect({
      ...goodPayload,
      Config: { Labels: {} },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.reason).toBe("missing_labels");
  });

  test("missing data mount returns no_data_mount", () => {
    const r = buildContextFromInspect({ ...goodPayload, Mounts: [] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.reason).toBe("no_data_mount");
  });

  test("missing network returns no_network", () => {
    const r = buildContextFromInspect({ ...goodPayload, NetworkSettings: { Networks: {} } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.reason).toBe("no_network");
  });
});

describe("#80 PR #1 discoverComposeContext with injected inspector", () => {
  test("inspector error → inspect_failed", async () => {
    const r = await discoverComposeContext(async () => ({ ok: false, message: "socket closed" }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.reason).toBe("inspect_failed");
    expect(r.error.message).toContain("socket closed");
  });

  test("inspector reports HOSTNAME unset → no_hostname", async () => {
    const r = await discoverComposeContext(async () => ({
      ok: false,
      message: "HOSTNAME env var unset",
    }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.reason).toBe("no_hostname");
  });

  test("happy path inspector → full context", async () => {
    const r = await discoverComposeContext(async () => ({
      ok: true,
      payload: {
        Config: {
          Labels: {
            [REQUIRED_COMPOSE_LABELS.project]: "moor",
            [REQUIRED_COMPOSE_LABELS.service]: "moor",
            [REQUIRED_COMPOSE_LABELS.workingDir]: "/root/moor",
            [REQUIRED_COMPOSE_LABELS.configFiles]: "docker-compose.yml,docker-compose.override.yml",
          },
        },
        Mounts: [{ Type: "bind", Source: "/srv/moor/data", Destination: "/app/data" }],
        NetworkSettings: { Networks: { moor_default: {} } },
      },
    }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.context.labels.config_files.length).toBe(2);
    expect(r.context.data_mount.type).toBe("bind");
    expect(r.context.default_network).toBe("moor_default");
  });
});
