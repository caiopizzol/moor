// MOOR_DB_PATH must be set before ../db.ts evaluates. Static `import`
// is hoisted above this assignment, so we dynamically import after the
// env var is set. Mirrors routes/projects.test.ts.
process.env.MOOR_DB_PATH = ":memory:";

import { beforeEach, describe, expect, test } from "bun:test";

const { default: db } = await import("./db");
const {
  getCredentialByHostname,
  listCredentials,
  getCredentialById,
  createCredential,
  updateCredential,
  deleteCredential,
  normalizeHostname,
} = await import("./registry-credentials-db");

describe("registry_credentials DB layer", () => {
  beforeEach(() => {
    db.query("DELETE FROM registry_credentials").run();
  });

  test("createCredential returns metadata with derived secret.kind and no raw secret", () => {
    const meta = createCredential({
      hostname: "ghcr.io",
      username: "alice",
      secret: "ghp_classic",
    });
    expect(meta.hostname).toBe("ghcr.io");
    expect(meta.username).toBe("alice");
    expect(meta.secret).toEqual({ configured: true, kind: "github_classic_pat" });
    expect(meta.id).toBeGreaterThan(0);
    expect(meta.created_at).toBeTruthy();
    expect(meta.updated_at).toBeTruthy();
  });

  test("createCredential normalizes hostname to lowercase", () => {
    const meta = createCredential({
      hostname: "GHCR.IO",
      username: "alice",
      secret: "ghp_a",
    });
    expect(meta.hostname).toBe("ghcr.io");
  });

  test("getCredentialByHostname returns the secret for the pull path", () => {
    createCredential({
      hostname: "ghcr.io",
      username: "alice",
      secret: "ghp_classic",
    });
    expect(getCredentialByHostname("ghcr.io")).toEqual({
      hostname: "ghcr.io",
      username: "alice",
      secret: "ghp_classic",
    });
  });

  test("getCredentialByHostname normalizes the lookup hostname", () => {
    createCredential({
      hostname: "ghcr.io",
      username: "alice",
      secret: "ghp_classic",
    });
    expect(getCredentialByHostname("GHCR.IO")?.secret).toBe("ghp_classic");
    expect(getCredentialByHostname("  ghcr.io  ")?.secret).toBe("ghp_classic");
  });

  test("getCredentialByHostname returns null on no match (anonymous fallback)", () => {
    expect(getCredentialByHostname("registry.example.com")).toBeNull();
  });

  test("hostname is unique - inserting twice on the same (normalized) host throws", () => {
    createCredential({ hostname: "ghcr.io", username: "alice", secret: "ghp_one" });
    expect(() =>
      createCredential({ hostname: "GHCR.IO", username: "bob", secret: "ghp_two" }),
    ).toThrow();
  });

  test("listCredentials returns all rows sorted by hostname, each with derived kind", () => {
    createCredential({ hostname: "ghcr.io", username: "alice", secret: "ghp_a" });
    createCredential({ hostname: "docker.io", username: "bob", secret: "hunter2" });
    const rows = listCredentials();
    expect(rows).toHaveLength(2);
    expect(rows[0].hostname).toBe("docker.io");
    expect(rows[0].secret).toEqual({ configured: true, kind: "unknown" });
    expect(rows[1].hostname).toBe("ghcr.io");
    expect(rows[1].secret).toEqual({ configured: true, kind: "github_classic_pat" });
    // No raw secret material leaks into the metadata shape.
    for (const row of rows) {
      expect(typeof row.secret).toBe("object");
      expect("configured" in row.secret).toBe(true);
      expect("kind" in row.secret).toBe(true);
    }
  });

  test("getCredentialById returns metadata or null", () => {
    const created = createCredential({
      hostname: "ghcr.io",
      username: "alice",
      secret: "github_pat_11ABC",
    });
    const found = getCredentialById(created.id);
    expect(found?.hostname).toBe("ghcr.io");
    expect(found?.secret.kind).toBe("github_fine_grained_pat");
    expect(getCredentialById(99999)).toBeNull();
  });

  test("updateCredential rotates secret, preserves created_at, advances updated_at and kind", async () => {
    const initial = createCredential({
      hostname: "ghcr.io",
      username: "alice",
      secret: "ghp_old",
    });
    expect(initial.secret.kind).toBe("github_classic_pat");
    // datetime('now') is second-precision; sleep so updated_at can advance.
    await Bun.sleep(1100);
    const rotated = updateCredential(initial.id, { secret: "github_pat_11NEW" });
    expect(rotated).not.toBeNull();
    if (!rotated) throw new Error("unreachable");
    expect(rotated.created_at).toBe(initial.created_at);
    expect(rotated.updated_at).not.toBe(initial.updated_at);
    expect(rotated.secret.kind).toBe("github_fine_grained_pat");
    expect(getCredentialByHostname("ghcr.io")?.secret).toBe("github_pat_11NEW");
  });

  test("updateCredential can rotate username and secret together", () => {
    const initial = createCredential({
      hostname: "ghcr.io",
      username: "alice",
      secret: "ghp_old",
    });
    const rotated = updateCredential(initial.id, { username: "bob", secret: "ghp_new" });
    expect(rotated?.username).toBe("bob");
    expect(getCredentialByHostname("ghcr.io")?.secret).toBe("ghp_new");
  });

  test("updateCredential with no fields is a no-op that returns current metadata", () => {
    const initial = createCredential({
      hostname: "ghcr.io",
      username: "alice",
      secret: "ghp_old",
    });
    const result = updateCredential(initial.id, {});
    expect(result?.id).toBe(initial.id);
    expect(result?.updated_at).toBe(initial.updated_at);
    expect(getCredentialByHostname("ghcr.io")?.secret).toBe("ghp_old");
  });

  test("updateCredential returns null when id does not exist", () => {
    expect(updateCredential(99999, { secret: "ghp_x" })).toBeNull();
  });

  test("deleteCredential returns true on success, false when missing", () => {
    const meta = createCredential({ hostname: "ghcr.io", username: "alice", secret: "ghp_a" });
    expect(deleteCredential(meta.id)).toBe(true);
    expect(getCredentialByHostname("ghcr.io")).toBeNull();
    expect(deleteCredential(meta.id)).toBe(false);
  });

  test("normalizeHostname lowercases and trims", () => {
    expect(normalizeHostname("GHCR.IO")).toBe("ghcr.io");
    expect(normalizeHostname("  ghcr.io  ")).toBe("ghcr.io");
    expect(normalizeHostname("localhost:5000")).toBe("localhost:5000");
  });

  test("createCredential rejects empty / whitespace-only fields", () => {
    expect(() => createCredential({ hostname: "", username: "alice", secret: "ghp_a" })).toThrow(
      /hostname/,
    );
    expect(() => createCredential({ hostname: "   ", username: "alice", secret: "ghp_a" })).toThrow(
      /hostname/,
    );
    expect(() => createCredential({ hostname: "ghcr.io", username: "", secret: "ghp_a" })).toThrow(
      /username/,
    );
    expect(() =>
      createCredential({ hostname: "ghcr.io", username: "  ", secret: "ghp_a" }),
    ).toThrow(/username/);
    expect(() => createCredential({ hostname: "ghcr.io", username: "alice", secret: "" })).toThrow(
      /secret/,
    );
    expect(() =>
      createCredential({ hostname: "ghcr.io", username: "alice", secret: "   " }),
    ).toThrow(/secret/);
  });

  test("updateCredential rejects empty / whitespace-only patch values when provided", () => {
    const meta = createCredential({
      hostname: "ghcr.io",
      username: "alice",
      secret: "ghp_a",
    });
    expect(() => updateCredential(meta.id, { username: "" })).toThrow(/username/);
    expect(() => updateCredential(meta.id, { secret: "   " })).toThrow(/secret/);
    // Absent fields are fine - validation only runs on provided ones.
    expect(() => updateCredential(meta.id, {})).not.toThrow();
  });
});
