// MOOR_DB_PATH must be set before ../db.ts evaluates. Dynamic imports
// below mirror routes/projects.test.ts and registry-credentials-db.test.ts.
process.env.MOOR_DB_PATH = ":memory:";

import { beforeEach, describe, expect, test } from "bun:test";

const { default: db } = await import("./db");
const {
  listCredentials,
  getCredentialById,
  getStoredCredentialById,
  listCredentialsByHostname,
  createCredential,
  updateCredential,
  recordCheckResult,
  projectsUsingCredential,
  deleteCredential,
} = await import("./source-credentials-db");

function insertProject(name: string, source_credential_id: number | null = null): { id: number } {
  return db
    .query(
      "INSERT INTO projects (name, github_url, branch, dockerfile, restart_policy, source_credential_id) VALUES (?, 'https://github.com/owner/' || ?, 'main', 'Dockerfile', 'unless-stopped', ?) RETURNING id",
    )
    .get(name, name, source_credential_id) as { id: number };
}

describe("source_credentials DB layer", () => {
  beforeEach(() => {
    db.query("DELETE FROM projects").run();
    db.query("DELETE FROM source_credentials").run();
  });

  describe("createCredential", () => {
    test("happy path returns metadata with derived kind, no raw secret", () => {
      const meta = createCredential({
        hostname: "github.com",
        label: "personal",
        username: "x-access-token",
        secret: "ghp_classic",
      });
      expect(meta.hostname).toBe("github.com");
      expect(meta.label).toBe("personal");
      expect(meta.username).toBe("x-access-token");
      expect(meta.secret).toEqual({ configured: true, kind: "github_classic_pat" });
      expect(meta.state).toBe("active");
    });

    test("normalizes hostname to lowercase", () => {
      const meta = createCredential({
        hostname: "GITHUB.COM",
        label: "x",
        username: "u",
        secret: "ghp_x",
      });
      expect(meta.hostname).toBe("github.com");
    });

    test("rejects empty/whitespace fields", () => {
      const base = { hostname: "github.com", label: "x", username: "u", secret: "ghp_x" };
      expect(() => createCredential({ ...base, hostname: "" })).toThrow(/hostname/);
      expect(() => createCredential({ ...base, hostname: "   " })).toThrow(/hostname/);
      expect(() => createCredential({ ...base, label: "" })).toThrow(/label/);
      expect(() => createCredential({ ...base, username: "" })).toThrow(/username/);
      expect(() => createCredential({ ...base, secret: "  " })).toThrow(/secret/);
    });

    test("label is trimmed at create so ' work ' and 'work' resolve to the same identity", () => {
      const first = createCredential({
        hostname: "github.com",
        label: "  work  ",
        username: "u",
        secret: "ghp_a",
      });
      expect(first.label).toBe("work");
      expect(() =>
        createCredential({ hostname: "github.com", label: "work", username: "u", secret: "ghp_b" }),
      ).toThrow();
    });
  });

  describe("uniqueness", () => {
    test("multiple github.com rows coexist when labels differ", () => {
      createCredential({
        hostname: "github.com",
        label: "personal",
        username: "u1",
        secret: "ghp_a",
      });
      createCredential({
        hostname: "github.com",
        label: "work",
        username: "u2",
        secret: "ghp_b",
      });
      expect(listCredentials()).toHaveLength(2);
    });

    test("(hostname, label) is unique - duplicate throws", () => {
      createCredential({
        hostname: "github.com",
        label: "personal",
        username: "u",
        secret: "ghp_a",
      });
      expect(() =>
        createCredential({
          hostname: "github.com",
          label: "personal",
          username: "u2",
          secret: "ghp_b",
        }),
      ).toThrow();
    });

    test("hostname case-variants normalize to one row in UNIQUE", () => {
      createCredential({
        hostname: "github.com",
        label: "personal",
        username: "u",
        secret: "ghp_a",
      });
      expect(() =>
        createCredential({
          hostname: "GITHUB.COM",
          label: "personal",
          username: "u",
          secret: "ghp_b",
        }),
      ).toThrow();
    });
  });

  describe("lookups", () => {
    test("listCredentialsByHostname returns all rows for a host, sorted by label", () => {
      createCredential({ hostname: "github.com", label: "work", username: "u", secret: "ghp_a" });
      createCredential({
        hostname: "github.com",
        label: "personal",
        username: "u",
        secret: "ghp_b",
      });
      createCredential({
        hostname: "gitlab.com",
        label: "personal",
        username: "u",
        secret: "glpat_x",
      });
      const rows = listCredentialsByHostname("github.com");
      expect(rows).toHaveLength(2);
      expect(rows[0].label).toBe("personal");
      expect(rows[1].label).toBe("work");
    });

    test("listCredentialsByHostname normalizes the lookup", () => {
      createCredential({ hostname: "github.com", label: "x", username: "u", secret: "ghp_a" });
      expect(listCredentialsByHostname("GITHUB.COM")).toHaveLength(1);
      expect(listCredentialsByHostname("  github.com  ")).toHaveLength(1);
    });

    test("getStoredCredentialById exposes the raw secret for internal use", () => {
      const meta = createCredential({
        hostname: "github.com",
        label: "x",
        username: "u",
        secret: "ghp_raw",
      });
      const stored = getStoredCredentialById(meta.id);
      expect(stored?.secret).toBe("ghp_raw");
    });

    test("metadata shape never carries the raw secret", () => {
      const meta = createCredential({
        hostname: "github.com",
        label: "x",
        username: "u",
        secret: "ghp_raw",
      });
      expect(JSON.stringify(listCredentials()).includes("ghp_raw")).toBe(false);
      expect(JSON.stringify(getCredentialById(meta.id)).includes("ghp_raw")).toBe(false);
    });
  });

  describe("updateCredential", () => {
    test("rotates secret, advances updated_at, preserves created_at", async () => {
      const initial = createCredential({
        hostname: "github.com",
        label: "x",
        username: "u",
        secret: "ghp_old",
      });
      await Bun.sleep(1100);
      const rotated = updateCredential(initial.id, { secret: "github_pat_NEW" });
      expect(rotated).not.toBeNull();
      if (!rotated) throw new Error("unreachable");
      expect(rotated.created_at).toBe(initial.created_at);
      expect(rotated.updated_at).not.toBe(initial.updated_at);
      expect(rotated.secret.kind).toBe("github_fine_grained_pat");
      expect(getStoredCredentialById(initial.id)?.secret).toBe("github_pat_NEW");
    });

    test("can patch label and username together", () => {
      const initial = createCredential({
        hostname: "github.com",
        label: "old",
        username: "alice",
        secret: "ghp_a",
      });
      const renamed = updateCredential(initial.id, { username: "bob", label: "new" });
      expect(renamed?.label).toBe("new");
      expect(renamed?.username).toBe("bob");
    });

    test("label is trimmed on update", () => {
      const initial = createCredential({
        hostname: "github.com",
        label: "old",
        username: "u",
        secret: "ghp_a",
      });
      const renamed = updateCredential(initial.id, { label: "  new  " });
      expect(renamed?.label).toBe("new");
    });

    test("empty patch is a no-op", () => {
      const initial = createCredential({
        hostname: "github.com",
        label: "x",
        username: "u",
        secret: "ghp_a",
      });
      const result = updateCredential(initial.id, {});
      expect(result?.updated_at).toBe(initial.updated_at);
    });

    test("rejects empty-string patches when provided", () => {
      const initial = createCredential({
        hostname: "github.com",
        label: "x",
        username: "u",
        secret: "ghp_a",
      });
      expect(() => updateCredential(initial.id, { username: "" })).toThrow(/username/);
      expect(() => updateCredential(initial.id, { label: "  " })).toThrow(/label/);
      expect(() => updateCredential(initial.id, { secret: "" })).toThrow(/secret/);
    });

    test("returns null for missing id", () => {
      expect(updateCredential(99999, { secret: "ghp_x" })).toBeNull();
    });
  });

  describe("schema CHECK constraints", () => {
    test("rejects unknown state at SQL level", () => {
      expect(() =>
        db
          .query(
            "INSERT INTO source_credentials (hostname, label, username, secret, state) VALUES (?, 'x', 'u', 's', 'frozen')",
          )
          .run("github.com"),
      ).toThrow(/CHECK constraint failed/);
    });
  });

  describe("recordCheckResult", () => {
    test("updates last_checked_at and last_check_status", async () => {
      const initial = createCredential({
        hostname: "github.com",
        label: "x",
        username: "u",
        secret: "ghp_a",
      });
      await Bun.sleep(1100);
      const after = recordCheckResult(initial.id, { status: "ok" });
      expect(after?.last_check_status).toBe("ok");
      expect(after?.last_checked_at).not.toBe(initial.last_checked_at);
    });

    test("can flip state to failed on a rejected check", () => {
      const initial = createCredential({
        hostname: "github.com",
        label: "x",
        username: "u",
        secret: "ghp_a",
      });
      const after = recordCheckResult(initial.id, { state: "failed", status: "clone_auth_failed" });
      expect(after?.state).toBe("failed");
    });
  });

  describe("deletion guards", () => {
    test("delete succeeds when no project references the credential", () => {
      const meta = createCredential({
        hostname: "github.com",
        label: "x",
        username: "u",
        secret: "ghp_a",
      });
      expect(deleteCredential(meta.id)).toEqual({ ok: true });
      expect(getCredentialById(meta.id)).toBeNull();
    });

    test("delete refuses with in_use when a project references the credential", () => {
      const meta = createCredential({
        hostname: "github.com",
        label: "x",
        username: "u",
        secret: "ghp_a",
      });
      insertProject("my-app", meta.id);
      const result = deleteCredential(meta.id);
      expect(result).toEqual({ ok: false, reason: "in_use", projects: ["my-app"] });
      expect(getCredentialById(meta.id)).not.toBeNull();
    });

    test("delete returns not_found for unknown id", () => {
      expect(deleteCredential(99999)).toEqual({ ok: false, reason: "not_found" });
    });

    test("projectsUsingCredential lists referencing project names", () => {
      const meta = createCredential({
        hostname: "github.com",
        label: "x",
        username: "u",
        secret: "ghp_a",
      });
      insertProject("a-app", meta.id);
      insertProject("b-app", meta.id);
      insertProject("unrelated", null);
      expect(projectsUsingCredential(meta.id)).toEqual(["a-app", "b-app"]);
    });
  });
});
