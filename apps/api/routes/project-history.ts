// #131 GET /api/projects/:id/stats/history?from=&to= — stored resource
// samples + lifecycle events for one project over a time window, with CPU
// averages and network/block rates derived at query time. Distinct from
// /container-stats, which is a single live snapshot. from/to are epoch ms;
// default window is the last 24h.

import { getProjectHistory } from "../project-history";

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function handleProjectHistory(req: Request, url: URL): Promise<Response | null> {
  const match = url.pathname.match(/^\/api\/projects\/(\d+)\/stats\/history$/);
  if (!match || req.method !== "GET") return null;
  const projectId = Number(match[1]);

  const now = Date.now();
  const toRaw = url.searchParams.get("to");
  const fromRaw = url.searchParams.get("from");
  const toNum = Number(toRaw);
  const fromNum = Number(fromRaw);
  const toMs = toRaw !== null && Number.isFinite(toNum) && toNum >= 0 ? toNum : now;
  const fromMs =
    fromRaw !== null && Number.isFinite(fromNum) && fromNum >= 0
      ? fromNum
      : toMs - DEFAULT_WINDOW_MS;
  if (fromMs > toMs) {
    return Response.json({ error: "from must be <= to" }, { status: 400 });
  }

  const history = getProjectHistory(projectId, fromMs, toMs);
  if (!history) return new Response("Project not found", { status: 404 });
  return Response.json({ from_ms: fromMs, to_ms: toMs, ...history });
}
