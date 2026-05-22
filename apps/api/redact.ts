// Issue #30: github_url values stored in the DB may include credentials embedded
// as `username:password@host`. We must never return those credentials in normal
// API responses (web UI list/detail, MCP project records, etc.), because anything
// that captures the response (LLM/agent transcripts, MCP client logs, screenshots,
// support tickets) ends up holding the raw secret. The DB value is kept intact so
// `git clone` against private repos keeps working.

export type StoredProject = {
  id: number;
  name: string;
  github_url: string | null;
  docker_image: string | null;
  branch: string | null;
  dockerfile: string | null;
  image_tag: string | null;
  container_id: string | null;
  status: string;
  domain: string | null;
  domain_port: number | null;
  restart_policy: string | null;
  created_at: string;
};

/** Strip `username:password@` from a URL. Returns the input unchanged when it has
 *  no credentials, is null/undefined, or fails to parse. Never throws. */
export function redactCredentials(url: string | null | undefined): string | null | undefined {
  if (url === null || url === undefined) return url;
  if (url === "") return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (!parsed.username && !parsed.password) return url;
  parsed.username = "";
  parsed.password = "";
  return parsed.toString();
}

/** Project record shaped for an external response: any `github_url` is redacted
 *  before serialization. All other fields pass through. */
export function serializeProject<T extends { github_url?: string | null }>(row: T): T {
  if (!row.github_url) return row;
  const redacted = redactCredentials(row.github_url);
  if (redacted === row.github_url) return row;
  return { ...row, github_url: redacted };
}

/** Redact credentials from a Docker Engine API path. Only the `remote=` query
 *  parameter on `/v1.44/build` carries a URL that may include `user:pass@`; all
 *  other Docker API paths are credential-free. Returns the input unchanged when
 *  there is no `remote=` or no credentials to strip. Used at the log site, not
 *  the wire — Docker still receives the original credentialed URL. */
export function redactDockerBuildPath(path: string): string {
  const qIdx = path.indexOf("?");
  if (qIdx === -1) return path;
  const params = new URLSearchParams(path.slice(qIdx + 1));
  const remote = params.get("remote");
  if (!remote) return path;
  // remote is "<url>#<branch>"; URL parses the fragment correctly.
  const redacted = redactCredentials(remote);
  if (redacted === remote || redacted === undefined || redacted === null) return path;
  params.set("remote", redacted);
  return `${path.slice(0, qIdx)}?${params.toString()}`;
}

/** Decide whether an incoming PUT for `github_url` should be applied or skipped.
 *  When the incoming value equals the redacted form of the stored URL, the caller
 *  is round-tripping a previous read (e.g. the web UI's edit modal saving an
 *  unrelated field) and we must preserve the stored credentialed URL.
 *  Returns `{ skip: true }` when the update should be ignored, `{ skip: false }`
 *  otherwise. */
export function reconcileGithubUrl(
  incoming: string | null | undefined,
  stored: string | null | undefined,
): { skip: boolean } {
  if (!stored) return { skip: false };
  if (incoming === undefined) return { skip: false };
  const redactedStored = redactCredentials(stored);
  return { skip: incoming === redactedStored };
}
