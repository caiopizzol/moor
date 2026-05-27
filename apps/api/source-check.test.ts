// Tests for performCheck via an injected LsRemoteRunner fake. No real
// git invocation, no network. Tests the resolution matrix (explicit
// id, anonymous, single candidate auto-select, ambiguous), the URL
// parser, the credential-host guard, and side effects on
// recordCheckResult.

process.env.MOOR_DB_PATH = ":memory:";

import { beforeEach, describe, expect, test } from "bun:test";
import type { LsRemoteRequest, LsRemoteRunResult } from "./git-ls-remote";

const { default: db } = await import("./db");
const { createCredential, getCredentialById } = await import("./source-credentials-db");
const { parseRepoUrl, performCheck } = await import("./source-check");

const HEAD_SUCCESS: LsRemoteRunResult = {
  exitCode: 0,
  stdout: "ref: refs/heads/main\tHEAD\n0123456789abcdef0123456789abcdef01234567\tHEAD\n",
  stderr: "",
  timedOut: false,
};
const AUTH_REQUIRED: LsRemoteRunResult = {
  exitCode: 128,
  stdout: "",
  stderr: "fatal: could not read Username for 'https://github.com'; terminal prompts disabled",
  timedOut: false,
};
const AUTH_FAILED: LsRemoteRunResult = {
  exitCode: 128,
  stdout: "",
  stderr: "remote: Authentication failed for 'https://github.com/...'",
  timedOut: false,
};
const REPO_NOT_FOUND: LsRemoteRunResult = {
  exitCode: 128,
  stdout: "",
  stderr: "remote: Repository not found.\nfatal: ...",
  timedOut: false,
};
const NETWORK_DOWN: LsRemoteRunResult = {
  exitCode: 128,
  stdout: "",
  stderr: "fatal: unable to access: Could not resolve host: github.com",
  timedOut: false,
};
const BRANCH_OK: LsRemoteRunResult = {
  exitCode: 0,
  stdout: "abcdef1234567890abcdef1234567890abcdef12\trefs/heads/feature\n",
  stderr: "",
  timedOut: false,
};

function makeRunner(plan: (req: LsRemoteRequest) => LsRemoteRunResult): {
  runner: (req: LsRemoteRequest) => Promise<LsRemoteRunResult>;
  calls: LsRemoteRequest[];
} {
  const calls: LsRemoteRequest[] = [];
  return {
    runner: async (req) => {
      calls.push(req);
      return plan(req);
    },
    calls,
  };
}

describe("parseRepoUrl", () => {
  test("happy path", () => {
    const r = parseRepoUrl("https://github.com/owner/repo");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.hostname).toBe("github.com");
      expect(r.value.owner).toBe("owner");
      expect(r.value.repo).toBe("repo");
      expect(r.value.httpsCloneUrl).toBe("https://github.com/owner/repo");
    }
  });

  test(".git suffix and trailing slash are stripped", () => {
    const r = parseRepoUrl("https://github.com/owner/repo.git/");
    if (r.ok) expect(r.value.httpsCloneUrl).toBe("https://github.com/owner/repo");
  });

  test("query string rejected", () => {
    expect(parseRepoUrl("https://github.com/owner/repo?ref=main").ok).toBe(false);
  });

  test("fragment rejected", () => {
    expect(parseRepoUrl("https://github.com/owner/repo#section").ok).toBe(false);
  });

  test("credentialed URL rejected", () => {
    expect(parseRepoUrl("https://x-access-token:token@github.com/owner/repo").ok).toBe(false);
  });

  test("non-https rejected", () => {
    expect(parseRepoUrl("git@github.com:owner/repo.git").ok).toBe(false);
  });

  test("nested path rejected", () => {
    expect(parseRepoUrl("https://github.com/owner/repo/tree/main").ok).toBe(false);
  });

  test("uppercase host normalized", () => {
    const r = parseRepoUrl("https://GITHUB.COM/owner/repo");
    if (r.ok) expect(r.value.hostname).toBe("github.com");
  });
});

describe("performCheck - anonymous path", () => {
  beforeEach(() => {
    db.query("DELETE FROM projects").run();
    db.query("DELETE FROM source_credentials").run();
  });

  test("public repo reachable anonymously", async () => {
    const { runner, calls } = makeRunner(() => HEAD_SUCCESS);
    const r = await performCheck({ github_url: "https://github.com/owner/repo" }, runner);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.default_branch).toBe("main");
      expect(r.head_sha).toBe("0123456789abcdef0123456789abcdef01234567");
    }
    expect(calls).toHaveLength(1);
    expect(calls[0].credential).toBeNull();
  });

  test("anonymous fails, zero candidates → source_credential_required", async () => {
    const { runner } = makeRunner(() => AUTH_REQUIRED);
    const r = await performCheck({ github_url: "https://github.com/owner/repo" }, runner);
    expect(r).toMatchObject({
      ok: false,
      code: "source_credential_required",
      hostname: "github.com",
    });
  });

  test("anonymous fails, one candidate → auto-select and test", async () => {
    const cred = createCredential({
      hostname: "github.com",
      label: "personal",
      username: "x-access-token",
      secret: "ghp_x",
    });
    let call = 0;
    const { runner } = makeRunner(() => (call++ === 0 ? AUTH_REQUIRED : HEAD_SUCCESS));
    const r = await performCheck({ github_url: "https://github.com/owner/repo" }, runner);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.auto_selected_credential_id).toBe(cred.id);
    }
    expect(getCredentialById(cred.id)?.last_check_status).toBe("ok");
  });

  test("anonymous fails, multiple candidates → source_credential_ambiguous", async () => {
    const a = createCredential({
      hostname: "github.com",
      label: "personal",
      username: "u",
      secret: "ghp_a",
    });
    const b = createCredential({
      hostname: "github.com",
      label: "work",
      username: "u",
      secret: "ghp_b",
    });
    const { runner } = makeRunner(() => AUTH_REQUIRED);
    const r = await performCheck({ github_url: "https://github.com/owner/repo" }, runner);
    expect(r.ok).toBe(false);
    if (!r.ok && r.code === "source_credential_ambiguous") {
      expect(r.candidates.map((c) => c.id).sort()).toEqual([a.id, b.id].sort());
      expect(r.candidates.find((c) => c.id === a.id)?.label).toBe("personal");
    } else {
      throw new Error("expected ambiguous");
    }
  });

  test("network failure short-circuits before candidate lookup", async () => {
    createCredential({
      hostname: "github.com",
      label: "x",
      username: "u",
      secret: "ghp_a",
    });
    const { runner, calls } = makeRunner(() => NETWORK_DOWN);
    const r = await performCheck({ github_url: "https://github.com/owner/repo" }, runner);
    expect(r).toEqual({ ok: false, code: "network_unreachable" });
    expect(calls).toHaveLength(1);
  });
});

describe("performCheck - explicit credential id", () => {
  beforeEach(() => {
    db.query("DELETE FROM projects").run();
    db.query("DELETE FROM source_credentials").run();
  });

  test("happy path", async () => {
    const cred = createCredential({
      hostname: "github.com",
      label: "personal",
      username: "x-access-token",
      secret: "ghp_x",
    });
    const { runner, calls } = makeRunner(() => HEAD_SUCCESS);
    const r = await performCheck(
      { github_url: "https://github.com/owner/repo", source_credential_id: cred.id },
      runner,
    );
    expect(r.ok).toBe(true);
    expect(calls[0].credential).toEqual({ username: "x-access-token", secret: "ghp_x" });
  });

  test("missing id → credential_not_found", async () => {
    const { runner } = makeRunner(() => HEAD_SUCCESS);
    const r = await performCheck(
      { github_url: "https://github.com/owner/repo", source_credential_id: 99999 },
      runner,
    );
    expect(r).toMatchObject({ ok: false, code: "credential_not_found" });
  });

  test("auth failure flips state to failed and returns clone_auth_failed with id", async () => {
    const cred = createCredential({
      hostname: "github.com",
      label: "x",
      username: "u",
      secret: "ghp_a",
    });
    const { runner } = makeRunner(() => AUTH_FAILED);
    const r = await performCheck(
      { github_url: "https://github.com/owner/repo", source_credential_id: cred.id },
      runner,
    );
    expect(r).toMatchObject({
      ok: false,
      code: "clone_auth_failed",
      source_credential_id: cred.id,
    });
    expect(getCredentialById(cred.id)?.state).toBe("failed");
  });

  test("repository not found with credential → repo_not_found_or_not_scoped", async () => {
    const cred = createCredential({
      hostname: "github.com",
      label: "x",
      username: "u",
      secret: "ghp_a",
    });
    const { runner } = makeRunner(() => REPO_NOT_FOUND);
    const r = await performCheck(
      { github_url: "https://github.com/owner/repo", source_credential_id: cred.id },
      runner,
    );
    expect(r).toMatchObject({
      ok: false,
      code: "repo_not_found_or_not_scoped",
      source_credential_id: cred.id,
    });
  });

  test("hostname mismatch → credential_host_mismatch, runner never invoked", async () => {
    const cred = createCredential({
      hostname: "gitlab.com",
      label: "x",
      username: "u",
      secret: "glpat_x",
    });
    const { runner, calls } = makeRunner(() => HEAD_SUCCESS);
    const r = await performCheck(
      { github_url: "https://github.com/owner/repo", source_credential_id: cred.id },
      runner,
    );
    expect(r).toEqual({
      ok: false,
      code: "credential_host_mismatch",
      source_credential_id: cred.id,
      credential_hostname: "gitlab.com",
      request_hostname: "github.com",
    });
    expect(calls).toHaveLength(0);
  });

  test("credential in failed state can be retested; success flips it back to active", async () => {
    // Recovery flow: rotation alone doesn't restore a failed credential.
    // The operator runs _check; if it passes, the row is active again.
    const cred = createCredential({
      hostname: "github.com",
      label: "x",
      username: "u",
      secret: "ghp_a",
      state: "failed",
    });
    const { runner, calls } = makeRunner(() => HEAD_SUCCESS);
    const r = await performCheck(
      { github_url: "https://github.com/owner/repo", source_credential_id: cred.id },
      runner,
    );
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(getCredentialById(cred.id)?.state).toBe("active");
  });

  test("failed credential that fails again stays failed", async () => {
    const cred = createCredential({
      hostname: "github.com",
      label: "x",
      username: "u",
      secret: "ghp_a",
      state: "failed",
    });
    const { runner } = makeRunner(() => AUTH_FAILED);
    await performCheck(
      { github_url: "https://github.com/owner/repo", source_credential_id: cred.id },
      runner,
    );
    expect(getCredentialById(cred.id)?.state).toBe("failed");
  });

  test("active credential that succeeds stays active (no needless state churn)", async () => {
    const cred = createCredential({
      hostname: "github.com",
      label: "x",
      username: "u",
      secret: "ghp_a",
    });
    const { runner } = makeRunner(() => HEAD_SUCCESS);
    await performCheck(
      { github_url: "https://github.com/owner/repo", source_credential_id: cred.id },
      runner,
    );
    expect(getCredentialById(cred.id)?.state).toBe("active");
  });
});

describe("performCheck - branch handling", () => {
  beforeEach(() => {
    db.query("DELETE FROM projects").run();
    db.query("DELETE FROM source_credentials").run();
  });

  test("branch found returns ref_sha and queries refs/heads/<branch>", async () => {
    const { runner, calls } = makeRunner(() => BRANCH_OK);
    const r = await performCheck(
      { github_url: "https://github.com/owner/repo", branch: "feature" },
      runner,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ref_sha).toBe("abcdef1234567890abcdef1234567890abcdef12");
    expect(calls[0].ref).toBe("refs/heads/feature");
  });

  test("missing branch with successful auth → branch_not_found", async () => {
    const cred = createCredential({
      hostname: "github.com",
      label: "x",
      username: "u",
      secret: "ghp_a",
    });
    const { runner } = makeRunner(() => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
    }));
    const r = await performCheck(
      {
        github_url: "https://github.com/owner/repo",
        branch: "missing",
        source_credential_id: cred.id,
      },
      runner,
    );
    expect(r).toEqual({ ok: false, code: "branch_not_found", branch: "missing" });
  });
});

describe("performCheck - invalid URL", () => {
  test("invalid URL returns invalid_url with reason", async () => {
    const { runner, calls } = makeRunner(() => HEAD_SUCCESS);
    const r = await performCheck({ github_url: "not-a-url" }, runner);
    expect(r.ok).toBe(false);
    if (!r.ok && r.code === "invalid_url") expect(r.reason).toMatch(/valid URL/);
    expect(calls).toHaveLength(0);
  });
});
