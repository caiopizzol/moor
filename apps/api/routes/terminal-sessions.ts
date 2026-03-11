import { getSessionsForProject, killSession } from "../terminal-sessions";

export async function handleTerminalSessions(req: Request, url: URL): Promise<Response | null> {
  // GET /api/projects/:id/terminal-sessions
  const listMatch = url.pathname.match(/^\/api\/projects\/(\d+)\/terminal-sessions$/);
  if (listMatch && req.method === "GET") {
    const projectId = Number(listMatch[1]);
    const sessions = getSessionsForProject(projectId);
    return Response.json({ sessions });
  }

  // POST /api/terminal-sessions/:execId/kill
  const killMatch = url.pathname.match(/^\/api\/terminal-sessions\/([a-f0-9]+)\/kill$/);
  if (killMatch && req.method === "POST") {
    const execId = killMatch[1];
    const killed = await killSession(execId);
    if (!killed) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }
    return Response.json({ ok: true });
  }

  return null;
}
