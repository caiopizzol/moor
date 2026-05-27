// Tests for parseLsRemoteOutput. Pure function - no spawn, no git
// invocation. The runner itself (runGitLsRemote) is exercised
// indirectly through source-check.test.ts with an injected fake.

import { describe, expect, test } from "bun:test";
import { type LsRemoteRunResult, parseLsRemoteOutput } from "./git-ls-remote";

function run(overrides: Partial<LsRemoteRunResult>): LsRemoteRunResult {
  return {
    exitCode: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    ...overrides,
  };
}

describe("parseLsRemoteOutput - success", () => {
  test("HEAD with symref returns default_branch and head_sha", () => {
    const out = parseLsRemoteOutput(
      run({
        stdout: "ref: refs/heads/main\tHEAD\n0123456789abcdef0123456789abcdef01234567\tHEAD\n",
      }),
      { hasCredential: false },
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.default_branch).toBe("main");
      expect(out.head_sha).toBe("0123456789abcdef0123456789abcdef01234567");
    }
  });

  test("specific ref query returns ref_sha", () => {
    const out = parseLsRemoteOutput(
      run({
        stdout:
          "ref: refs/heads/main\tHEAD\nabcdef1234567890abcdef1234567890abcdef12\trefs/heads/feature\n",
      }),
      { ref: "refs/heads/feature", hasCredential: false },
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.ref_sha).toBe("abcdef1234567890abcdef1234567890abcdef12");
    }
  });

  test("requested ref absent → branch_not_found", () => {
    // Empty stdout, exit 0: ref simply doesn't exist on remote.
    const out = parseLsRemoteOutput(run({ stdout: "" }), {
      ref: "refs/heads/missing-branch",
      hasCredential: true,
    });
    expect(out).toEqual({ ok: false, code: "branch_not_found" });
  });

  test("default branch with unusual name (e.g. trunk) is parsed", () => {
    const out = parseLsRemoteOutput(
      run({
        stdout: "ref: refs/heads/trunk\tHEAD\nabc123def456abc123def456abc123def456abc1\tHEAD\n",
      }),
      { hasCredential: false },
    );
    if (out.ok) expect(out.default_branch).toBe("trunk");
  });
});

describe("parseLsRemoteOutput - errors", () => {
  test("timeout → network_unreachable", () => {
    const out = parseLsRemoteOutput(run({ exitCode: null, timedOut: true }), {
      hasCredential: false,
    });
    expect(out).toEqual({ ok: false, code: "network_unreachable" });
  });

  test("auth failure with credential → clone_auth_failed", () => {
    const out = parseLsRemoteOutput(
      run({ exitCode: 128, stderr: "fatal: Authentication failed for 'https://...'" }),
      { hasCredential: true },
    );
    expect(out).toEqual({ ok: false, code: "clone_auth_failed" });
  });

  test("auth required without credential → source_access_denied_or_not_found", () => {
    const out = parseLsRemoteOutput(
      run({ exitCode: 128, stderr: "fatal: could not read Username for 'https://github.com'" }),
      { hasCredential: false },
    );
    expect(out).toEqual({ ok: false, code: "source_access_denied_or_not_found" });
  });

  test("terminal prompts disabled (GIT_TERMINAL_PROMPT=0) without cred → access_denied_or_not_found", () => {
    const out = parseLsRemoteOutput(
      run({ exitCode: 128, stderr: "fatal: could not read Username; terminal prompts disabled" }),
      { hasCredential: false },
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("source_access_denied_or_not_found");
  });

  test("repository not found with credential → repo_not_found_or_not_scoped", () => {
    const out = parseLsRemoteOutput(
      run({ exitCode: 128, stderr: "remote: Repository not found.\nfatal: ..." }),
      { hasCredential: true },
    );
    expect(out).toEqual({ ok: false, code: "repo_not_found_or_not_scoped" });
  });

  test("repository not found without credential → access_denied_or_not_found", () => {
    const out = parseLsRemoteOutput(
      run({ exitCode: 128, stderr: "remote: Repository not found.\nfatal: ..." }),
      { hasCredential: false },
    );
    expect(out).toEqual({ ok: false, code: "source_access_denied_or_not_found" });
  });

  test("network unreachable", () => {
    const out = parseLsRemoteOutput(
      run({
        exitCode: 128,
        stderr:
          "fatal: unable to access 'https://github.com/foo/bar/': Could not resolve host: github.com",
      }),
      { hasCredential: true },
    );
    expect(out).toEqual({ ok: false, code: "network_unreachable" });
  });

  test("unknown failure → git_error", () => {
    const out = parseLsRemoteOutput(
      run({ exitCode: 128, stderr: "fatal: some new error we don't classify yet" }),
      { hasCredential: true },
    );
    expect(out).toEqual({ ok: false, code: "git_error" });
  });
});
