// Helpers for Docker registry auth. Two pure functions:
//
//   - buildXRegistryAuth: encodes (username, password, serveraddress)
//     into the padded base64url JSON payload the Docker daemon expects
//     on the X-Registry-Auth header for /images/create. Matches Go's
//     base64.URLEncoding (RFC 4648 §5 with padding), which is what
//     Docker's EncodeAuthConfig produces.
//
//   - deriveSecretKind: maps known fixed token prefixes to a stable
//     "kind" string. Used in write-only API reads so an operator can
//     confirm the kind of token stored without exposing secret
//     material. "unknown" is the honest default; we do not guess.

export function buildXRegistryAuth(
  username: string,
  password: string,
  serverAddress: string,
): string {
  const payload = { username, password, serveraddress: serverAddress };
  return Buffer.from(JSON.stringify(payload))
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_");
}

export type SecretKind = "github_classic_pat" | "github_fine_grained_pat" | "unknown";

export function deriveSecretKind(secret: string): SecretKind {
  if (secret.startsWith("ghp_")) return "github_classic_pat";
  if (secret.startsWith("github_pat_")) return "github_fine_grained_pat";
  return "unknown";
}

/** Build the headers object for a /images/create call: returns either
 *  { "X-Registry-Auth": ... } when a credential is provided, or {}
 *  for anonymous pulls. Anonymous fallback is load-bearing so public
 *  images keep working when no credential is configured for the host. */
export function buildPullAuthHeaders(
  parsed: { serverAddress: string },
  credential: { username: string; secret: string } | null,
): Record<string, string> {
  if (!credential) return {};
  return {
    "X-Registry-Auth": buildXRegistryAuth(
      credential.username,
      credential.secret,
      parsed.serverAddress,
    ),
  };
}
