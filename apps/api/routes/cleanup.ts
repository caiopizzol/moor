// #54 routes for guarded cleanup. Server-level on purpose — orphan-volume
// cleanup (v2) belongs here too because it isn't a property of any single
// project, and overloading /api/projects/:id/volumes/* would muddle the
// "DELETE there preserves Docker data" contract introduced in #35.

import { executeCleanup, planCleanup, validateExecuteCandidates, validateScope } from "../cleanup";
import { errorResponse, readJsonObject } from "../http";

export async function handleCleanup(
  req: Request,
  url: URL,
  operations = { plan: planCleanup, execute: executeCleanup },
): Promise<Response | null> {
  if (url.pathname === "/api/server/cleanup/plan" && req.method === "POST") {
    const body = await readJsonObject(req, { allowEmpty: true });
    if (!body.ok) return body.response;
    const scope = validateScope(body.value.scope);
    if (!scope.ok) return errorResponse(scope.error, 400);
    try {
      return Response.json(await operations.plan(scope.value));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      return errorResponse(msg, 500);
    }
  }

  if (url.pathname === "/api/server/cleanup/execute" && req.method === "POST") {
    const body = await readJsonObject(req, { allowEmpty: true });
    if (!body.ok) return body.response;
    const candidates = validateExecuteCandidates(body.value.candidates);
    if (!candidates.ok) return errorResponse(candidates.error, 400);
    try {
      return Response.json(await operations.execute(candidates.value));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      return errorResponse(msg, 500);
    }
  }

  return null;
}
