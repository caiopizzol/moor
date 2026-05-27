// Tests for the build-time credential resolver. Pure DB calls; no
// network, no git, no Docker.

process.env.MOOR_DB_PATH = ":memory:";

import { beforeEach, describe, expect, test } from "bun:test";

const { default: db } = await import("./db");
const { createCredential } = await import("./source-credentials-db");
const { resolveCredentialForBuild } = await import("./source-credential-resolver");

describe("resolveCredentialForBuild", () => {
  beforeEach(() => {
    db.query("DELETE FROM projects").run();
    db.query("DELETE FROM source_credentials").run();
  });

  describe("URL validation", () => {
    test("invalid URL → invalid_url with reason", () => {
      const r = resolveCredentialForBuild("not-a-url", undefined);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("invalid_url");
    });

    test("legacy embedded-credentials URL without id → returns URL as-is (compat)", () => {
      // Pre-#115 projects stored creds in github_url. Build path must
      // keep working until operator migrates to a credentials-table row.
      const legacy = "https://x-access-token:ghp_legacy@github.com/owner/repo";
      const r = resolveCredentialForBuild(legacy, undefined);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.cloneUrl).toBe(legacy);
        expect(r.value.used_credential_id).toBeNull();
      }
    });

    test("legacy embedded-credentials URL with id → embedded_credentials_conflict", () => {
      // Don't let operators mix new typed creds with old embedded ones.
      // Force a clean URL before pinning a source_credential_id.
      const r = resolveCredentialForBuild(
        "https://x-access-token:ghp_legacy@github.com/owner/repo",
        7,
      );
      expect(r.ok).toBe(false);
      if (!r.ok && r.code === "embedded_credentials_conflict") {
        expect(r.source_credential_id).toBe(7);
      }
    });
  });

  describe("explicit source_credential_id", () => {
    test("happy path returns credentialed URL using URL.username/password", () => {
      const cred = createCredential({
        hostname: "github.com",
        label: "personal",
        username: "x-access-token",
        secret: "ghp_realsecret",
      });
      const r = resolveCredentialForBuild("https://github.com/owner/repo", cred.id);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.used_credential_id).toBe(cred.id);
        const u = new URL(r.value.cloneUrl);
        expect(u.username).toBe("x-access-token");
        expect(u.password).toBe("ghp_realsecret");
        expect(u.host).toBe("github.com");
        expect(u.pathname).toBe("/owner/repo");
      }
    });

    test("special characters in secret are percent-encoded (URL.password setter)", () => {
      const cred = createCredential({
        hostname: "github.com",
        label: "personal",
        username: "x-access-token",
        secret: "p@ss/word:with?chars",
      });
      const r = resolveCredentialForBuild("https://github.com/owner/repo", cred.id);
      expect(r.ok).toBe(true);
      if (r.ok) {
        // The exact encoding string is implementation-defined (WHATWG URL
        // has its own delimiter table). The contract that matters: the
        // URL parses cleanly, the daemon sees one URL with one host/path,
        // and the decoded password equals the original secret.
        const u = new URL(r.value.cloneUrl);
        expect(u.host).toBe("github.com");
        expect(u.pathname).toBe("/owner/repo");
        expect(decodeURIComponent(u.password)).toBe("p@ss/word:with?chars");
        // Raw chars must not leak unencoded into the URL string.
        expect(r.value.cloneUrl.includes("/word:with?chars")).toBe(false);
        // The path's "?" delimiter is not corrupted by the secret's "?".
        expect(u.search).toBe("");
      }
    });

    test("missing id → credential_not_found", () => {
      const r = resolveCredentialForBuild("https://github.com/owner/repo", 99999);
      expect(r.ok).toBe(false);
      if (!r.ok && r.code === "credential_not_found") {
        expect(r.source_credential_id).toBe(99999);
      }
    });

    test("hostname mismatch → credential_host_mismatch (no synthesis)", () => {
      const cred = createCredential({
        hostname: "gitlab.com",
        label: "x",
        username: "oauth2",
        secret: "glpat_x",
      });
      const r = resolveCredentialForBuild("https://github.com/owner/repo", cred.id);
      expect(r.ok).toBe(false);
      if (!r.ok && r.code === "credential_host_mismatch") {
        expect(r.credential_hostname).toBe("gitlab.com");
        expect(r.request_hostname).toBe("github.com");
      }
    });

    test("failed credential → credential_not_active (strict at build time)", () => {
      const cred = createCredential({
        hostname: "github.com",
        label: "x",
        username: "x-access-token",
        secret: "ghp_a",
        state: "failed",
      });
      const r = resolveCredentialForBuild("https://github.com/owner/repo", cred.id);
      expect(r.ok).toBe(false);
      if (!r.ok && r.code === "credential_not_active") {
        expect(r.state).toBe("failed");
      }
    });
  });

  describe("auto-resolution without source_credential_id", () => {
    test("zero candidates → clean URL, no credential applied", () => {
      const r = resolveCredentialForBuild("https://github.com/owner/repo", undefined);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.used_credential_id).toBeNull();
        expect(r.value.cloneUrl).toBe("https://github.com/owner/repo");
      }
    });

    test("one active candidate → auto-select and synthesize credentialed URL", () => {
      const cred = createCredential({
        hostname: "github.com",
        label: "personal",
        username: "x-access-token",
        secret: "ghp_a",
      });
      const r = resolveCredentialForBuild("https://github.com/owner/repo", undefined);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.used_credential_id).toBe(cred.id);
        expect(new URL(r.value.cloneUrl).password).toBe("ghp_a");
      }
    });

    test("two active candidates → source_credential_ambiguous", () => {
      const a = createCredential({
        hostname: "github.com",
        label: "personal",
        username: "x-access-token",
        secret: "ghp_a",
      });
      const b = createCredential({
        hostname: "github.com",
        label: "work",
        username: "x-access-token",
        secret: "ghp_b",
      });
      const r = resolveCredentialForBuild("https://github.com/owner/repo", undefined);
      expect(r.ok).toBe(false);
      if (!r.ok && r.code === "source_credential_ambiguous") {
        expect(r.candidates.map((c) => c.id).sort()).toEqual([a.id, b.id].sort());
        expect(r.hostname).toBe("github.com");
      }
    });

    test("failed credentials are invisible to auto-select", () => {
      // One failed + one active → use the active without ambiguity.
      createCredential({
        hostname: "github.com",
        label: "broken",
        username: "x-access-token",
        secret: "ghp_broken",
        state: "failed",
      });
      const good = createCredential({
        hostname: "github.com",
        label: "good",
        username: "x-access-token",
        secret: "ghp_good",
      });
      const r = resolveCredentialForBuild("https://github.com/owner/repo", undefined);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.used_credential_id).toBe(good.id);
        expect(new URL(r.value.cloneUrl).password).toBe("ghp_good");
      }
    });

    test("all candidates failed → no usable credential, falls back to clean URL", () => {
      createCredential({
        hostname: "github.com",
        label: "x",
        username: "x-access-token",
        secret: "ghp_x",
        state: "failed",
      });
      const r = resolveCredentialForBuild("https://github.com/owner/repo", undefined);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.used_credential_id).toBeNull();
        expect(r.value.cloneUrl).toBe("https://github.com/owner/repo");
      }
    });
  });

  describe("URL canonicalization", () => {
    test(".git suffix is stripped before credential synthesis", () => {
      const cred = createCredential({
        hostname: "github.com",
        label: "x",
        username: "x-access-token",
        secret: "ghp_a",
      });
      const r = resolveCredentialForBuild("https://github.com/owner/repo.git", cred.id);
      if (r.ok) {
        const u = new URL(r.value.cloneUrl);
        expect(u.pathname).toBe("/owner/repo");
      }
    });

    test("uppercase host is normalized in stored row; explicit id with mixed-case URL resolves", () => {
      const cred = createCredential({
        hostname: "github.com",
        label: "x",
        username: "x-access-token",
        secret: "ghp_a",
      });
      const r = resolveCredentialForBuild("https://GITHUB.com/owner/repo", cred.id);
      expect(r.ok).toBe(true);
    });
  });
});
