// DB layer for registry_credentials. Two type shapes:
//
//   - StoredCredential: includes the raw secret. The pull path uses
//     this to build X-Registry-Auth. Internal use only; never returned
//     from an API surface.
//
//   - CredentialMetadata: includes `secret: { configured, kind }` but
//     not the secret material. `kind` is derived at read time by
//     deriveSecretKind. This is the only shape API/MCP reads return.
//
// Hostname is normalized to lowercase at write and read time so
// `GHCR.IO` and `ghcr.io` resolve to the same row. Without this, the
// SQLite UNIQUE(hostname) constraint (BINARY collation) could let two
// rows coexist for the same logical registry, and parseImageRef output
// would silently miss credentials stored with a different casing.

import db from "./db";
import { deriveSecretKind, type SecretKind } from "./registry-auth";

export type StoredCredential = {
  hostname: string;
  username: string;
  secret: string;
};

export type CredentialMetadata = {
  id: number;
  hostname: string;
  username: string;
  secret: { configured: true; kind: SecretKind };
  created_at: string;
  updated_at: string;
};

type RowWithSecret = {
  id: number;
  hostname: string;
  username: string;
  secret: string;
  created_at: string;
  updated_at: string;
};

export function normalizeHostname(host: string): string {
  return host.trim().toLowerCase();
}

/** Reject empty / whitespace-only hostname, username, secret before
 *  storing. Catches both empty-string and "   " inputs that would
 *  otherwise pass the NOT NULL SQL constraint and live as garbage
 *  rows. Patch shapes only validate the fields actually provided. */
function validateCredentialInput(input: {
  hostname?: string;
  username?: string;
  secret?: string;
}): void {
  if (input.hostname !== undefined && normalizeHostname(input.hostname) === "") {
    throw new Error("hostname is required and must not be empty");
  }
  if (input.username !== undefined && input.username.trim() === "") {
    throw new Error("username is required and must not be empty");
  }
  if (input.secret !== undefined && input.secret.trim() === "") {
    throw new Error("secret is required and must not be empty");
  }
}

function toMetadata(row: RowWithSecret): CredentialMetadata {
  return {
    id: row.id,
    hostname: row.hostname,
    username: row.username,
    secret: { configured: true, kind: deriveSecretKind(row.secret) },
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function getCredentialByHostname(hostname: string): StoredCredential | null {
  const row = db
    .query("SELECT hostname, username, secret FROM registry_credentials WHERE hostname = ?")
    .get(normalizeHostname(hostname)) as StoredCredential | null;
  return row ?? null;
}

export function listCredentials(): CredentialMetadata[] {
  const rows = db
    .query(
      "SELECT id, hostname, username, secret, created_at, updated_at FROM registry_credentials ORDER BY hostname",
    )
    .all() as RowWithSecret[];
  return rows.map(toMetadata);
}

export function getCredentialById(id: number): CredentialMetadata | null {
  const row = db
    .query(
      "SELECT id, hostname, username, secret, created_at, updated_at FROM registry_credentials WHERE id = ?",
    )
    .get(id) as RowWithSecret | null;
  return row ? toMetadata(row) : null;
}

export function createCredential(input: {
  hostname: string;
  username: string;
  secret: string;
}): CredentialMetadata {
  validateCredentialInput(input);
  const row = db
    .query(
      `INSERT INTO registry_credentials (hostname, username, secret)
       VALUES (?, ?, ?)
       RETURNING id, hostname, username, secret, created_at, updated_at`,
    )
    .get(normalizeHostname(input.hostname), input.username, input.secret) as RowWithSecret;
  return toMetadata(row);
}

/** Rotate username and/or secret on an existing credential. Returns the
 *  updated metadata, or null if no row matched. `updated_at` advances to
 *  now whenever a field changes; `created_at` is preserved. Hostname is
 *  intentionally not patchable: changing the lookup key on an existing
 *  row would silently break the pull path for in-flight refs. To change
 *  hostnames, delete and re-create. */
export function updateCredential(
  id: number,
  patch: { username?: string; secret?: string },
): CredentialMetadata | null {
  validateCredentialInput(patch);
  const sets: string[] = [];
  const params: (string | number)[] = [];
  if (patch.username !== undefined) {
    sets.push("username = ?");
    params.push(patch.username);
  }
  if (patch.secret !== undefined) {
    sets.push("secret = ?");
    params.push(patch.secret);
  }
  if (sets.length === 0) {
    return getCredentialById(id);
  }
  sets.push("updated_at = datetime('now')");
  params.push(id);

  const row = db
    .query(
      `UPDATE registry_credentials
       SET ${sets.join(", ")}
       WHERE id = ?
       RETURNING id, hostname, username, secret, created_at, updated_at`,
    )
    .get(...params) as RowWithSecret | null;
  return row ? toMetadata(row) : null;
}

export function deleteCredential(id: number): boolean {
  return db.query("DELETE FROM registry_credentials WHERE id = ?").run(id).changes > 0;
}
