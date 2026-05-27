// HTTP routes for per-host source credentials. Server-level operator
// configuration, lives under /api/server/ alongside drain/backup/update
// and registry-credentials.
//
// Includes CRUD and the `/check` endpoint (real git ls-remote).
//
// v1 is HTTPS PAT only. SSH deploy keys (and the auth_type column)
// are deferred until there is concrete demand.
//
// Boundary contract:
//   - POST accepts hostname, label, username, secret, expires_at?.
//     State is server-managed; create always produces an 'active' row.
//   - PUT accepts username?, secret?, label?, expires_at?. Hostname
//     and state are NOT patchable through this route; passing either
//     yields 400.
//   - DELETE requires confirm_label as a query param matching the row's
//     label exactly. credential_in_use returns 409 with the project list.
//   - All reads return metadata only; raw secret never crosses the API.

import { normalizeHostname } from "../source-auth";
import { type CheckRequest, type LsRemoteRunner, performCheck } from "../source-check";
import {
  type CredentialMetadata,
  createCredential,
  deleteCredential,
  getCredentialById,
  listCredentials,
  updateCredential,
} from "../source-credentials-db";

const COLLECTION = /^\/api\/server\/source-credentials\/?$/;
const ITEM = /^\/api\/server\/source-credentials\/(\d+)$/;
const CHECK = /^\/api\/server\/source-credentials\/check\/?$/;

// Injectable for tests; production uses the default (real git binary).
let checkRunner: LsRemoteRunner | undefined;
export function setCheckRunnerForTesting(runner: LsRemoteRunner | undefined): void {
  checkRunner = runner;
}

export async function handleSourceCredentials(req: Request, url: URL): Promise<Response | null> {
  // /check must be matched before the /:id pattern.
  if (CHECK.test(url.pathname)) {
    if (req.method === "POST") return handleCheck(req);
    return new Response("Method Not Allowed", { status: 405 });
  }

  const itemMatch = url.pathname.match(ITEM);
  if (itemMatch) {
    const id = Number(itemMatch[1]);
    if (req.method === "GET") return handleGet(id);
    if (req.method === "PUT") return handleUpdate(req, id);
    if (req.method === "DELETE") return handleDelete(url, id);
    return new Response("Method Not Allowed", { status: 405 });
  }

  if (COLLECTION.test(url.pathname)) {
    if (req.method === "GET") return handleList();
    if (req.method === "POST") return handleCreate(req);
    return new Response("Method Not Allowed", { status: 405 });
  }

  return null;
}

function handleList(): Response {
  return Response.json({ rows: listCredentials() });
}

function handleGet(id: number): Response {
  const row = getCredentialById(id);
  if (!row) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(row);
}

async function handleCreate(req: Request): Promise<Response> {
  const body = await readJsonObject(req);
  if (!body.ok) return body.response;

  const parsed = parseCreateBody(body.value);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

  try {
    const meta = createCredential(parsed.value);
    return Response.json(meta, { status: 201 });
  } catch (e) {
    return mapDbError(e, parsed.value.hostname, parsed.value.label);
  }
}

async function handleUpdate(req: Request, id: number): Promise<Response> {
  const body = await readJsonObject(req);
  if (!body.ok) return body.response;

  const parsed = parseUpdateBody(body.value);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

  let meta: CredentialMetadata | null;
  try {
    meta = updateCredential(id, parsed.value);
  } catch (e) {
    return mapUpdateError(e);
  }
  if (!meta) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(meta);
}

async function handleCheck(req: Request): Promise<Response> {
  const body = await readJsonObject(req);
  if (!body.ok) return body.response;

  const parsed = parseCheckBody(body.value);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

  const result = await performCheck(parsed.value, checkRunner);
  if (result.ok) return Response.json(result);

  const statusByCode: Record<typeof result.code, number> = {
    invalid_url: 400,
    credential_not_found: 404,
    credential_host_mismatch: 400,
    source_credential_required: 401,
    source_credential_ambiguous: 409,
    credential_not_active: 409,
    clone_auth_failed: 401,
    repo_not_found_or_not_scoped: 404,
    branch_not_found: 404,
    network_unreachable: 502,
    source_access_denied_or_not_found: 401,
    git_error: 502,
  };
  return Response.json(result, { status: statusByCode[result.code] });
}

function parseCheckBody(
  body: Record<string, unknown>,
): { ok: true; value: CheckRequest } | { ok: false; error: string } {
  if (typeof body.github_url !== "string" || body.github_url.trim() === "") {
    return { ok: false, error: "github_url is required and must be a non-empty string" };
  }
  const value: CheckRequest = { github_url: body.github_url };
  if ("branch" in body && body.branch !== undefined && body.branch !== null) {
    if (typeof body.branch !== "string" || body.branch.trim() === "") {
      return { ok: false, error: "branch must be a non-empty string when provided" };
    }
    value.branch = body.branch;
  }
  if (
    "source_credential_id" in body &&
    body.source_credential_id !== undefined &&
    body.source_credential_id !== null
  ) {
    if (
      typeof body.source_credential_id !== "number" ||
      !Number.isInteger(body.source_credential_id) ||
      body.source_credential_id <= 0
    ) {
      return {
        ok: false,
        error: "source_credential_id must be a positive integer when provided",
      };
    }
    value.source_credential_id = body.source_credential_id;
  }
  return { ok: true, value };
}

function handleDelete(url: URL, id: number): Response {
  const confirmLabel = url.searchParams.get("confirm_label");
  if (confirmLabel === null) {
    return Response.json({ error: "confirm_label query param is required" }, { status: 400 });
  }

  const current = getCredentialById(id);
  if (!current) return Response.json({ error: "not found" }, { status: 404 });

  if (confirmLabel !== current.label) {
    return Response.json(
      {
        error: `confirm_label "${confirmLabel}" does not match credential's label "${current.label}"`,
      },
      { status: 400 },
    );
  }

  const result = deleteCredential(id);
  if (result.ok) return new Response(null, { status: 204 });
  if (result.reason === "not_found") {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  return Response.json(
    {
      error: "credential_in_use",
      message: `cannot delete: referenced by ${result.projects.length} project(s)`,
      projects: result.projects,
    },
    { status: 409 },
  );
}

// --- body parsing ---

type JsonObjectOk = { ok: true; value: Record<string, unknown> };
type JsonObjectErr = { ok: false; response: Response };

async function readJsonObject(req: Request): Promise<JsonObjectOk | JsonObjectErr> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return {
      ok: false,
      response: Response.json({ error: "invalid JSON body" }, { status: 400 }),
    };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      ok: false,
      response: Response.json({ error: "request body must be a JSON object" }, { status: 400 }),
    };
  }
  return { ok: true, value: raw as Record<string, unknown> };
}

type CreateOk = {
  ok: true;
  value: {
    hostname: string;
    label: string;
    username: string;
    secret: string;
    expires_at: string | null;
  };
};
type ParseErr = { ok: false; error: string };

function parseCreateBody(body: Record<string, unknown>): CreateOk | ParseErr {
  if ("state" in body) {
    return { ok: false, error: "state is not settable on create; flips happen via check" };
  }
  if ("auth_type" in body) {
    return { ok: false, error: "auth_type is not accepted; v1 supports HTTPS PAT only" };
  }
  if ("public_key" in body) {
    return { ok: false, error: "public_key is not accepted; v1 supports HTTPS PAT only" };
  }
  const hostErr = checkRequiredString(body.hostname, "hostname");
  if (hostErr) return { ok: false, error: hostErr };
  const hostShapeErr = checkHostnameShape(body.hostname as string);
  if (hostShapeErr) return { ok: false, error: hostShapeErr };

  const labelErr = checkRequiredString(body.label, "label");
  if (labelErr) return { ok: false, error: labelErr };
  const usernameErr = checkRequiredString(body.username, "username");
  if (usernameErr) return { ok: false, error: usernameErr };
  const secretErr = checkRequiredString(body.secret, "secret");
  if (secretErr) return { ok: false, error: secretErr };

  let expiresAt: string | null = null;
  if ("expires_at" in body) {
    if (body.expires_at !== null && typeof body.expires_at !== "string") {
      return { ok: false, error: "expires_at must be a string or null" };
    }
    expiresAt = (body.expires_at as string | null) ?? null;
  }

  return {
    ok: true,
    value: {
      hostname: body.hostname as string,
      label: body.label as string,
      username: body.username as string,
      secret: body.secret as string,
      expires_at: expiresAt,
    },
  };
}

type UpdateOk = {
  ok: true;
  value: { username?: string; secret?: string; label?: string; expires_at?: string | null };
};

function parseUpdateBody(body: Record<string, unknown>): UpdateOk | ParseErr {
  for (const blocked of ["hostname", "auth_type", "public_key", "state"]) {
    if (blocked in body) {
      return {
        ok: false,
        error: `${blocked} is not patchable; delete and recreate to change ${blocked}`,
      };
    }
  }

  const out: { username?: string; secret?: string; label?: string; expires_at?: string | null } =
    {};
  if ("username" in body) {
    const err = checkRequiredString(body.username, "username");
    if (err) return { ok: false, error: err };
    out.username = body.username as string;
  }
  if ("secret" in body) {
    const err = checkRequiredString(body.secret, "secret");
    if (err) return { ok: false, error: err };
    out.secret = body.secret as string;
  }
  if ("label" in body) {
    const err = checkRequiredString(body.label, "label");
    if (err) return { ok: false, error: err };
    out.label = body.label as string;
  }
  if ("expires_at" in body) {
    if (body.expires_at !== null && typeof body.expires_at !== "string") {
      return { ok: false, error: "expires_at must be a string or null" };
    }
    out.expires_at = body.expires_at as string | null;
  }

  return { ok: true, value: out };
}

function checkRequiredString(v: unknown, field: string): string | null {
  if (typeof v !== "string") return `${field} must be a string`;
  if (v.trim() === "") return `${field} must not be empty`;
  return null;
}

function checkHostnameShape(host: string): string | null {
  const trimmed = host.trim();
  if (trimmed.includes("/")) {
    return "hostname must not contain '/' (looks like a URL or repo path; use bare host)";
  }
  if (/\s/.test(trimmed)) {
    return "hostname must not contain internal whitespace";
  }
  return null;
}

function mapDbError(e: unknown, hostname: string, label: string): Response {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes("UNIQUE constraint failed")) {
    return Response.json(
      {
        error: `credential for ${normalizeHostname(hostname)} with label "${label.trim()}" already exists`,
      },
      { status: 409 },
    );
  }
  if (/required|must|invalid/i.test(msg)) {
    return Response.json({ error: msg }, { status: 400 });
  }
  return Response.json({ error: msg }, { status: 500 });
}

function mapUpdateError(e: unknown): Response {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes("UNIQUE constraint failed")) {
    return Response.json(
      { error: "another credential already exists with that (hostname, label)" },
      { status: 409 },
    );
  }
  if (/required|must|invalid/i.test(msg)) {
    return Response.json({ error: msg }, { status: 400 });
  }
  return Response.json({ error: msg }, { status: 500 });
}
