// Pure helpers for source credentials.
//
//   - deriveSecretKind: maps known fixed token prefixes to a stable
//     "kind" string. Used in write-only API reads so operators can
//     confirm what they stored without exposing secret material.
//     "unknown" is the honest default; no guessing.
//
//   - normalizeHostname: lowercases + trims. Matches the parseImageRef-
//     equivalent normalization registry credentials use.
//
// v1 is HTTPS PAT only. Additional auth types (SSH deploy keys, OAuth,
// GitHub App installation tokens) are intentionally not shipped here.

export type CredentialState = "active" | "failed";

export type SecretKind = "github_classic_pat" | "github_fine_grained_pat" | "unknown";

export function deriveSecretKind(secret: string): SecretKind {
  if (secret.startsWith("ghp_")) return "github_classic_pat";
  if (secret.startsWith("github_pat_")) return "github_fine_grained_pat";
  return "unknown";
}

export function normalizeHostname(host: string): string {
  return host.trim().toLowerCase();
}
