// Build-time credential resolution for source repos. Stricter than the
// check resolver (apps/api/source-check.ts) on three points:
//
//   1. Build only accepts state=active credentials. A failed credential
//      is surfaced (credential_not_active) so the build does not silently
//      fall back to anonymous and succeed-looking error. Recovery flow
//      (PUT secret + _check) is the operator's path back to active.
//
//   2. No anonymous probe. The build is the probe; resolution just
//      decides "credentialed URL with this token" vs "clean URL, let
//      Docker daemon try anonymously."
//
//   3. No auto-select, no ambiguity check (#120). `source_credential_id`
//      is the only signal. Null means "anonymous clone, do not inspect
//      the credentials table." Operators use /check to discover which
//      credential to pin; pinning is then explicit on the project row or
//      the deploy call. This keeps project state read-as-truth.
//
// Returns either a clone URL (clean or credentialed) for the daemon's
// remote= param, plus the id of the credential it picked (null when
// no credential was applied). The credentialed URL only exists in
// memory; the caller passes it to dockerFetch and never stores it.

import { parseRepoUrl } from "./source-check";
import type { StoredCredential } from "./source-credentials-db";
import { getStoredCredentialById } from "./source-credentials-db";

export type BuildCloneInfo = {
  /** URL to pass as Docker's remote= param. May or may not contain credentials. */
  cloneUrl: string;
  /** Which credential row was applied. null when no credential is used. */
  used_credential_id: number | null;
};

export type ResolveFailure =
  | { ok: false; code: "invalid_url"; reason: string }
  | { ok: false; code: "credential_not_found"; source_credential_id: number }
  | {
      ok: false;
      code: "credential_host_mismatch";
      source_credential_id: number;
      credential_hostname: string;
      request_hostname: string;
    }
  | { ok: false; code: "credential_not_active"; source_credential_id: number; state: string }
  | {
      ok: false;
      code: "embedded_credentials_conflict";
      source_credential_id: number;
    };

export type ResolveResult = { ok: true; value: BuildCloneInfo } | ResolveFailure;

/** Resolve a github_url + optional source_credential_id into a clone URL
 *  for Docker's daemon-side remote= build. The credentialed URL is
 *  in-memory only; never persisted.
 *
 *  Null source_credential_id means anonymous clone (#120). The resolver
 *  does not read the source_credentials table in that case; the daemon
 *  attempts the clone with no auth and surfaces its own error if the
 *  repo is private. Operators discover which credential to attach via
 *  /check, then pin it explicitly on the project row or the deploy call.
 *
 *  Legacy compatibility: projects created before #115 may have
 *  username:password embedded in github_url (the pre-typed-credential
 *  pattern). For those:
 *    - no source_credential_id → return the URL as-is so the build
 *      still works; redaction at the log layer continues to apply.
 *    - source_credential_id provided → reject (embedded_credentials_conflict).
 *      New typed credentials must not mix with legacy embedded ones; the
 *      operator should clean the URL before pinning a credential. */
export function resolveCredentialForBuild(
  github_url: string,
  source_credential_id: number | undefined,
): ResolveResult {
  // Detect legacy embedded-credentials before parseRepoUrl rejects them.
  if (hasEmbeddedCredentials(github_url)) {
    if (source_credential_id !== undefined) {
      return {
        ok: false,
        code: "embedded_credentials_conflict",
        source_credential_id,
      };
    }
    return {
      ok: true,
      value: { cloneUrl: github_url, used_credential_id: null },
    };
  }

  const parsed = parseRepoUrl(github_url);
  if (!parsed.ok) {
    return { ok: false, code: "invalid_url", reason: parsed.reason };
  }
  const repo = parsed.value;

  // Null id: anonymous clone. No DB inspection, no host lookup. The
  // project's source_credential_id is read-as-truth.
  if (source_credential_id === undefined) {
    return {
      ok: true,
      value: { cloneUrl: repo.httpsCloneUrl, used_credential_id: null },
    };
  }

  // Explicit credential id path.
  const stored = getStoredCredentialById(source_credential_id);
  if (!stored) {
    return { ok: false, code: "credential_not_found", source_credential_id };
  }
  if (stored.hostname !== repo.hostname) {
    return {
      ok: false,
      code: "credential_host_mismatch",
      source_credential_id,
      credential_hostname: stored.hostname,
      request_hostname: repo.hostname,
    };
  }
  if (stored.state !== "active") {
    return {
      ok: false,
      code: "credential_not_active",
      source_credential_id: stored.id,
      state: stored.state,
    };
  }
  return {
    ok: true,
    value: {
      cloneUrl: synthesizeCredentialedUrl(repo.httpsCloneUrl, stored),
      used_credential_id: stored.id,
    },
  };
}

/** Build the credentialed URL via URL.username / URL.password so the
 *  WHATWG URL parser handles percent-encoding of any special characters
 *  in the secret. Never use string interpolation here. */
function synthesizeCredentialedUrl(httpsCloneUrl: string, stored: StoredCredential): string {
  const url = new URL(httpsCloneUrl);
  url.username = stored.username;
  url.password = stored.secret;
  return url.toString();
}

/** Returns true if the URL string has username or password components.
 *  Pre-#115 projects stored credentials this way; build path keeps
 *  honoring them so existing rows don't regress. Returns false on
 *  unparseable input (parseRepoUrl will surface invalid_url next). */
function hasEmbeddedCredentials(url: string): boolean {
  try {
    const u = new URL(url);
    return u.username !== "" || u.password !== "";
  } catch {
    return false;
  }
}
