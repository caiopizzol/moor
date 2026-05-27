// DB layer for source_credentials. Two type shapes:
//
//   - StoredCredential: the raw row including the secret. Used by the
//     build path to authenticate to git. NEVER returned from an
//     API/MCP read.
//
//   - CredentialMetadata: includes `secret: { configured, kind }`
//     derived at read time. The shape all read paths return.
//
// Multiple rows can share a hostname (`UNIQUE(hostname, label)`).
// Build-time resolution either takes an explicit `source_credential_id`
// from the project row or resolves by hostname with explicit ambiguity
// errors when more than one row matches. No silent guessing.
//
// State machine:
//   active  ready for use
//   failed  last check rejected; rotation needed
//
// v1 is HTTPS PAT only.

import db from "./db";
import {
  type CredentialState,
  deriveSecretKind,
  normalizeHostname,
  type SecretKind,
} from "./source-auth";

export type StoredCredential = {
  id: number;
  hostname: string;
  label: string;
  username: string;
  secret: string;
  state: CredentialState;
};

export type CredentialMetadata = {
  id: number;
  hostname: string;
  label: string;
  username: string;
  secret: { configured: true; kind: SecretKind };
  state: CredentialState;
  expires_at: string | null;
  last_checked_at: string | null;
  last_check_status: string | null;
  created_at: string;
  updated_at: string;
};

type FullRow = {
  id: number;
  hostname: string;
  label: string;
  username: string;
  secret: string;
  state: CredentialState;
  expires_at: string | null;
  last_checked_at: string | null;
  last_check_status: string | null;
  created_at: string;
  updated_at: string;
};

const SELECT_COLUMNS =
  "id, hostname, label, username, secret, state, expires_at, last_checked_at, last_check_status, created_at, updated_at";

function toMetadata(row: FullRow): CredentialMetadata {
  return {
    id: row.id,
    hostname: row.hostname,
    label: row.label,
    username: row.username,
    secret: { configured: true, kind: deriveSecretKind(row.secret) },
    state: row.state,
    expires_at: row.expires_at,
    last_checked_at: row.last_checked_at,
    last_check_status: row.last_check_status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toStored(row: FullRow): StoredCredential {
  return {
    id: row.id,
    hostname: row.hostname,
    label: row.label,
    username: row.username,
    secret: row.secret,
    state: row.state,
  };
}

function validateCreateInput(input: {
  hostname: string;
  label: string;
  username: string;
  secret: string;
  state?: string;
}): void {
  if (typeof input.hostname !== "string" || normalizeHostname(input.hostname) === "") {
    throw new Error("hostname is required and must not be empty");
  }
  if (typeof input.label !== "string" || input.label.trim() === "") {
    throw new Error("label is required and must not be empty");
  }
  if (typeof input.username !== "string" || input.username.trim() === "") {
    throw new Error("username is required and must not be empty");
  }
  if (typeof input.secret !== "string" || input.secret.trim() === "") {
    throw new Error("secret is required and must not be empty");
  }
  if (input.state !== undefined && input.state !== "active" && input.state !== "failed") {
    throw new Error("state must be one of: active | failed");
  }
}

function validatePatchInput(patch: { username?: string; secret?: string; label?: string }): void {
  if (patch.label !== undefined && (typeof patch.label !== "string" || patch.label.trim() === "")) {
    throw new Error("label is required and must not be empty");
  }
  if (
    patch.username !== undefined &&
    (typeof patch.username !== "string" || patch.username.trim() === "")
  ) {
    throw new Error("username is required and must not be empty");
  }
  if (
    patch.secret !== undefined &&
    (typeof patch.secret !== "string" || patch.secret.trim() === "")
  ) {
    throw new Error("secret is required and must not be empty");
  }
}

export function listCredentials(): CredentialMetadata[] {
  const rows = db
    .query(`SELECT ${SELECT_COLUMNS} FROM source_credentials ORDER BY hostname, label`)
    .all() as FullRow[];
  return rows.map(toMetadata);
}

export function getCredentialById(id: number): CredentialMetadata | null {
  const row = db
    .query(`SELECT ${SELECT_COLUMNS} FROM source_credentials WHERE id = ?`)
    .get(id) as FullRow | null;
  return row ? toMetadata(row) : null;
}

/** Internal-only: returns the raw secret. Used by the pull path to
 *  authenticate. Never expose from an API or MCP response. */
export function getStoredCredentialById(id: number): StoredCredential | null {
  const row = db
    .query(`SELECT ${SELECT_COLUMNS} FROM source_credentials WHERE id = ?`)
    .get(id) as FullRow | null;
  return row ? toStored(row) : null;
}

export function listCredentialsByHostname(hostname: string): CredentialMetadata[] {
  const rows = db
    .query(`SELECT ${SELECT_COLUMNS} FROM source_credentials WHERE hostname = ? ORDER BY label`)
    .all(normalizeHostname(hostname)) as FullRow[];
  return rows.map(toMetadata);
}

export function createCredential(input: {
  hostname: string;
  label: string;
  username: string;
  secret: string;
  state?: CredentialState;
  expires_at?: string | null;
}): CredentialMetadata {
  validateCreateInput(input);
  const state = input.state ?? "active";
  const row = db
    .query(
      `INSERT INTO source_credentials
         (hostname, label, username, secret, state, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)
       RETURNING ${SELECT_COLUMNS}`,
    )
    .get(
      normalizeHostname(input.hostname),
      input.label.trim(),
      input.username,
      input.secret,
      state,
      input.expires_at ?? null,
    ) as FullRow;
  return toMetadata(row);
}

/** Rotate fields on an existing credential. Returns updated metadata,
 *  or null if the row doesn't exist. Hostname is intentionally NOT
 *  patchable: changing the lookup key on an existing row would silently
 *  break the pull path for in-flight refs. To change hostname, delete
 *  and recreate. */
export function updateCredential(
  id: number,
  patch: { username?: string; secret?: string; label?: string; expires_at?: string | null },
): CredentialMetadata | null {
  validatePatchInput(patch);
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if (patch.username !== undefined) {
    sets.push("username = ?");
    params.push(patch.username);
  }
  if (patch.secret !== undefined) {
    sets.push("secret = ?");
    params.push(patch.secret);
  }
  if (patch.label !== undefined) {
    sets.push("label = ?");
    params.push(patch.label.trim());
  }
  if (patch.expires_at !== undefined) {
    sets.push("expires_at = ?");
    params.push(patch.expires_at);
  }
  if (sets.length === 0) {
    return getCredentialById(id);
  }
  sets.push("updated_at = datetime('now')");
  params.push(id);

  const row = db
    .query(
      `UPDATE source_credentials SET ${sets.join(", ")} WHERE id = ? RETURNING ${SELECT_COLUMNS}`,
    )
    .get(...params) as FullRow | null;
  return row ? toMetadata(row) : null;
}

/** Update last_checked_at and last_check_status; optionally flip state.
 *  Called by the check endpoint after each ls-remote. */
export function recordCheckResult(
  id: number,
  result: { state?: CredentialState; status: string },
): CredentialMetadata | null {
  const sets: string[] = ["last_checked_at = datetime('now')", "last_check_status = ?"];
  const params: (string | number | null)[] = [result.status];
  if (result.state !== undefined) {
    sets.push("state = ?");
    params.push(result.state);
  }
  sets.push("updated_at = datetime('now')");
  params.push(id);

  const row = db
    .query(
      `UPDATE source_credentials SET ${sets.join(", ")} WHERE id = ? RETURNING ${SELECT_COLUMNS}`,
    )
    .get(...params) as FullRow | null;
  return row ? toMetadata(row) : null;
}

export function projectsUsingCredential(id: number): string[] {
  const rows = db
    .query("SELECT name FROM projects WHERE source_credential_id = ? ORDER BY name")
    .all(id) as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

export type DeleteResult =
  | { ok: true }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "in_use"; projects: string[] };

export function deleteCredential(id: number): DeleteResult {
  const using = projectsUsingCredential(id);
  if (using.length > 0) {
    return { ok: false, reason: "in_use", projects: using };
  }
  const changes = db.query("DELETE FROM source_credentials WHERE id = ?").run(id).changes;
  if (changes === 0) return { ok: false, reason: "not_found" };
  return { ok: true };
}
