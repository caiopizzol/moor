// Orchestration for /api/server/source-credentials/check.
//
// Stable resolution rules:
//
//   With source_credential_id:
//     - Test exactly that credential. Never substitute.
//     - Reject when the credential's hostname does not match the URL's
//       (so the secret never goes to the wrong server).
//
//   Without source_credential_id:
//     - Try anonymous first. If the URL is reachable without auth,
//       return reachable:true with default_branch and head_sha.
//     - If anonymous fails: look up host candidates.
//         0 candidates  → source_credential_required
//         1 candidate   → test it; return result + auto_selected_credential_id
//         2+ candidates → source_credential_ambiguous with the list
//
// Branch handling: when `branch` is provided, query `refs/heads/<branch>`
// directly. A successful exit with no matching ref ⇒ branch_not_found.
//
// Side effect: any credentialed test calls recordCheckResult so the
// credential's last_checked_at / last_check_status / state stay current.
// A failed check on an active credential flips it to failed.

import {
  type LsRemoteRequest,
  type LsRemoteRunResult,
  parseLsRemoteOutput,
  runGitLsRemote,
} from "./git-ls-remote";
import { type CredentialState, normalizeHostname } from "./source-auth";
import {
  type CredentialMetadata,
  getStoredCredentialById,
  listCredentialsByHostname,
  recordCheckResult,
  type StoredCredential,
} from "./source-credentials-db";

export type CheckRequest = {
  github_url: string;
  branch?: string;
  source_credential_id?: number;
};

export type CheckSuccess = {
  ok: true;
  reachable: true;
  default_branch?: string;
  head_sha?: string;
  ref_sha?: string;
  auto_selected_credential_id?: number;
};

export type CheckFailure =
  | { ok: false; code: "invalid_url"; reason: string }
  | { ok: false; code: "credential_not_found"; source_credential_id: number }
  | {
      ok: false;
      code: "credential_host_mismatch";
      source_credential_id: number;
      credential_hostname: string;
      request_hostname: string;
    }
  | { ok: false; code: "source_credential_required"; hostname: string }
  | {
      ok: false;
      code: "source_credential_ambiguous";
      hostname: string;
      candidates: Array<{ id: number; label: string }>;
    }
  | { ok: false; code: "credential_not_active"; source_credential_id: number; state: string }
  | { ok: false; code: "clone_auth_failed"; source_credential_id?: number }
  | { ok: false; code: "repo_not_found_or_not_scoped"; source_credential_id?: number }
  | { ok: false; code: "branch_not_found"; branch: string }
  | { ok: false; code: "network_unreachable" }
  | { ok: false; code: "source_access_denied_or_not_found" }
  | { ok: false; code: "git_error" };

export type CheckResult = CheckSuccess | CheckFailure;

export type LsRemoteRunner = (req: LsRemoteRequest) => Promise<LsRemoteRunResult>;

type ParsedRepoUrl = {
  hostname: string;
  owner: string;
  repo: string;
  httpsCloneUrl: string;
};

export function parseRepoUrl(
  url: string,
): { ok: true; value: ParsedRepoUrl } | { ok: false; reason: string } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, reason: "github_url is not a valid URL" };
  }
  if (u.protocol !== "https:") {
    return { ok: false, reason: "github_url must use https://" };
  }
  if (u.search !== "") return { ok: false, reason: "github_url must not have a query string" };
  if (u.hash !== "") return { ok: false, reason: "github_url must not have a fragment" };
  if (u.username !== "" || u.password !== "") {
    return {
      ok: false,
      reason: "github_url must not embed credentials; use source_credential_id instead",
    };
  }
  const pathMatch = u.pathname.match(/^\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!pathMatch) {
    return { ok: false, reason: "github_url path must be /owner/repo (optional .git)" };
  }
  const [, owner, repo] = pathMatch;
  const hostname = u.host.toLowerCase();
  return {
    ok: true,
    value: { hostname, owner, repo, httpsCloneUrl: `https://${hostname}/${owner}/${repo}` },
  };
}

async function testCredential(
  runner: LsRemoteRunner,
  parsed: ParsedRepoUrl,
  branch: string | undefined,
  stored: StoredCredential,
): Promise<CheckResult> {
  // Both active and failed credentials are testable. Recovery flow:
  //   1. credential's last check failed → state=failed
  //   2. operator rotates via PUT secret (state stays failed)
  //   3. operator calls _check → if it passes now, state flips active
  // Without this, a failed credential would be unrecoverable through
  // the API (the operator would have to delete/recreate or touch the
  // DB directly). Future states like 'pending' or 'revoked' would
  // keep the credential_not_active guard.

  const ref = branch ? `refs/heads/${branch}` : undefined;
  const run = await runner({
    url: parsed.httpsCloneUrl,
    ref,
    credential: { username: stored.username, secret: stored.secret },
  });
  const parsedOut = parseLsRemoteOutput(run, { ref, hasCredential: true });

  // Side effect: record check result and update state in both
  // directions. Success → active (recovers a failed credential).
  // Failure → failed (marks an active credential as stale).
  const status = parsedOut.ok ? "ok" : parsedOut.code;
  const newState: CredentialState = parsedOut.ok ? "active" : "failed";
  recordCheckResult(stored.id, { status, state: newState });

  if (parsedOut.ok) {
    return {
      ok: true,
      reachable: true,
      default_branch: parsedOut.default_branch,
      head_sha: parsedOut.head_sha,
      ref_sha: parsedOut.ref_sha,
    };
  }
  if (parsedOut.code === "branch_not_found") {
    return { ok: false, code: "branch_not_found", branch: branch ?? "" };
  }
  if (parsedOut.code === "clone_auth_failed" || parsedOut.code === "repo_not_found_or_not_scoped") {
    return { ok: false, code: parsedOut.code, source_credential_id: stored.id };
  }
  return { ok: false, code: parsedOut.code };
}

export async function performCheck(
  req: CheckRequest,
  runner: LsRemoteRunner = runGitLsRemote,
): Promise<CheckResult> {
  const parsedUrl = parseRepoUrl(req.github_url);
  if (!parsedUrl.ok) {
    return { ok: false, code: "invalid_url", reason: parsedUrl.reason };
  }
  const parsed = parsedUrl.value;

  if (req.source_credential_id !== undefined) {
    const stored = getStoredCredentialById(req.source_credential_id);
    if (!stored) {
      return {
        ok: false,
        code: "credential_not_found",
        source_credential_id: req.source_credential_id,
      };
    }
    if (stored.hostname !== parsed.hostname) {
      return {
        ok: false,
        code: "credential_host_mismatch",
        source_credential_id: req.source_credential_id,
        credential_hostname: stored.hostname,
        request_hostname: parsed.hostname,
      };
    }
    return testCredential(runner, parsed, req.branch, stored);
  }

  // Resolve path: anonymous first.
  const ref = req.branch ? `refs/heads/${req.branch}` : undefined;
  const anonRun = await runner({ url: parsed.httpsCloneUrl, ref, credential: null });
  const anonParsed = parseLsRemoteOutput(anonRun, { ref, hasCredential: false });
  if (anonParsed.ok) {
    return {
      ok: true,
      reachable: true,
      default_branch: anonParsed.default_branch,
      head_sha: anonParsed.head_sha,
      ref_sha: anonParsed.ref_sha,
    };
  }
  if (anonParsed.code === "branch_not_found") {
    return { ok: false, code: "branch_not_found", branch: req.branch ?? "" };
  }
  if (anonParsed.code === "network_unreachable") {
    return { ok: false, code: "network_unreachable" };
  }

  const hostname = normalizeHostname(parsed.hostname);
  const candidates = listCredentialsByHostname(hostname);
  if (candidates.length === 0) {
    return { ok: false, code: "source_credential_required", hostname };
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      code: "source_credential_ambiguous",
      hostname,
      candidates: candidates.map((c: CredentialMetadata) => ({ id: c.id, label: c.label })),
    };
  }
  const sole = candidates[0];
  const stored = getStoredCredentialById(sole.id);
  if (!stored) {
    return { ok: false, code: "source_credential_required", hostname };
  }
  const tested = await testCredential(runner, parsed, req.branch, stored);
  if (tested.ok) {
    return { ...tested, auto_selected_credential_id: stored.id };
  }
  return tested;
}
