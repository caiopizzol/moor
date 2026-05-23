// #54 routes for guarded cleanup. Server-level on purpose — orphan-volume
// cleanup (v2) belongs here too because it isn't a property of any single
// project, and overloading /api/projects/:id/volumes/* would muddle the
// "DELETE there preserves Docker data" contract introduced in #35.

import { executeCleanup, planCleanup, validateExecuteCandidates, validateScope } from "../cleanup";

export async function handleCleanup(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname === "/api/server/cleanup/plan" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const scope = validateScope((body as { scope?: unknown }).scope);
    if (!scope.ok) return new Response(scope.error, { status: 400 });
    try {
      return Response.json(await planCleanup(scope.value));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      return Response.json({ error: msg }, { status: 500 });
    }
  }

  if (url.pathname === "/api/server/cleanup/execute" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { candidates?: unknown };
    const candidates = validateExecuteCandidates(body.candidates);
    if (!candidates.ok) return new Response(candidates.error, { status: 400 });
    try {
      return Response.json(await executeCleanup(candidates.value));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      return Response.json({ error: msg }, { status: 500 });
    }
  }

  return null;
}
