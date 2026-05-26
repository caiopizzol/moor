// HTTP routes for per-registry credentials. Server-level operator
// configuration, lives under /api/server/ alongside drain/backup/update.
//
// Read shape is write-only: GET/list responses carry the metadata plus
// `secret: { configured, kind }`; the raw secret never crosses the API
// boundary. The pull path reads the secret directly from the DB layer.
//
// Hostname is rejected at the boundary if it would not match what
// parseImageRef produces: no `/` (catches both `https://ghcr.io` and
// `ghcr.io/owner/img`) and no whitespace. Without this, an operator
// could store a credential that the pull-path lookup would never find.

import {
  type CredentialMetadata,
  createCredential,
  deleteCredential,
  getCredentialById,
  listCredentials,
  normalizeHostname,
  updateCredential,
} from "../registry-credentials-db";

const COLLECTION = /^\/api\/server\/registry-credentials\/?$/;
const ITEM = /^\/api\/server\/registry-credentials\/(\d+)$/;

export async function handleRegistryCredentials(req: Request, url: URL): Promise<Response | null> {
  const itemMatch = url.pathname.match(ITEM);
  if (itemMatch) {
    const id = Number(itemMatch[1]);
    if (req.method === "GET") return handleGet(id);
    if (req.method === "PUT") return handleUpdate(req, id);
    if (req.method === "DELETE") return handleDelete(id);
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
    return mapDbError(e, parsed.value.hostname);
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
    return mapDbError(e, null);
  }
  if (!meta) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(meta);
}

function handleDelete(id: number): Response {
  const ok = deleteCredential(id);
  if (!ok) return Response.json({ error: "not found" }, { status: 404 });
  return new Response(null, { status: 204 });
}

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
  value: { hostname: string; username: string; secret: string };
};
type ParseErr = { ok: false; error: string };

function parseCreateBody(body: Record<string, unknown>): CreateOk | ParseErr {
  const hostErr = checkRequiredString(body.hostname, "hostname");
  if (hostErr) return { ok: false, error: hostErr };
  const userErr = checkRequiredString(body.username, "username");
  if (userErr) return { ok: false, error: userErr };
  const secErr = checkRequiredString(body.secret, "secret");
  if (secErr) return { ok: false, error: secErr };

  const hostname = body.hostname as string;
  const hostShapeErr = checkHostnameShape(hostname);
  if (hostShapeErr) return { ok: false, error: hostShapeErr };

  return {
    ok: true,
    value: { hostname, username: body.username as string, secret: body.secret as string },
  };
}

type UpdateOk = { ok: true; value: { username?: string; secret?: string } };

function parseUpdateBody(body: Record<string, unknown>): UpdateOk | ParseErr {
  if ("hostname" in body) {
    return {
      ok: false,
      error: "hostname is not patchable; delete and recreate to change hostname",
    };
  }
  const out: { username?: string; secret?: string } = {};
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
  return { ok: true, value: out };
}

function checkRequiredString(v: unknown, field: string): string | null {
  if (typeof v !== "string") return `${field} must be a string`;
  if (v.trim() === "") return `${field} must not be empty`;
  return null;
}

function checkHostnameShape(host: string): string | null {
  if (host.includes("/")) {
    return "hostname must not contain '/' (looks like a URL or image ref - use bare host)";
  }
  if (/\s/.test(host)) return "hostname must not contain whitespace";
  return null;
}

function mapDbError(e: unknown, hostname: string | null): Response {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes("UNIQUE constraint failed")) {
    const label = hostname ? `for ${normalizeHostname(hostname)}` : "";
    return Response.json({ error: `credential ${label} already exists`.trim() }, { status: 409 });
  }
  // Boundary already validates shape; reaching here means an unexpected
  // DB-layer failure. Surface as 500 rather than swallow.
  return Response.json({ error: msg }, { status: 500 });
}
