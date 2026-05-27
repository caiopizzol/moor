// #119: classify Docker build errors so agents get a structured signal
// when a private-repo build needs a source credential. The build path's
// equivalent of parseLsRemoteOutput's auth detection.
//
// Scope is intentionally narrow: only auth-shaped failures map to
// source_credential_required. Network / repo-not-found / TLS errors stay
// as unknown for v1 because each of them has a different remediation
// (DNS, repo name, cert pinning) and conflating them with "need a PAT"
// would mislead the agent. Adding more codes later is a non-breaking
// extension to the return union.
//
// Operates on already-redacted text. Both buildImageStreaming (apps/api/
// docker.ts) and the route catch boundary call redactCredentialsInText
// before the message reaches here, so the regex never sees a live secret.

export type BuildErrorCode = "source_credential_required" | "unknown";

/** Classify a Docker build error message. Returns "source_credential_required"
 *  if the daemon's stderr looks like a Git auth failure (private repo without
 *  credentials, or invalid PAT), "unknown" otherwise.
 *
 *  Patterns mirror parseLsRemoteOutput in git-ls-remote.ts so /check and
 *  the build path classify the same Git output the same way. */
export function classifyBuildError(message: string): BuildErrorCode {
  const lc = message.toLowerCase();
  if (
    /authentication failed|invalid username or password|terminal prompts disabled|could not read username|fatal: authentication/i.test(
      lc,
    )
  ) {
    return "source_credential_required";
  }
  return "unknown";
}
