import { activeBuildRuns } from "../build-runs";
import { stopCronRun } from "../cron";
import db from "../db";

const PAGE_SIZE = 20;

export async function handleRuns(req: Request, url: URL): Promise<Response | null> {
  // /api/projects/:id/runs
  const projectMatch = url.pathname.match(/^\/api\/projects\/(\d+)\/runs$/);
  if (projectMatch && req.method === "GET") {
    const projectId = Number(projectMatch[1]);
    const page = Number(url.searchParams.get("page") || "1");
    const offset = (page - 1) * PAGE_SIZE;
    // include_output defaults to true to preserve the existing web-UI
    // contract. MCP/agent callers should pass include_output=false to skip
    // the potentially-large stdout/stderr payloads and get byte counts
    // instead — recreates a softer version of the #44 problem otherwise. #37.
    const includeOutput = url.searchParams.get("include_output") !== "false";

    // #65: stdout_total_bytes / stderr_total_bytes are the truth Docker
    // emitted (live-build rows store at most a 64 KiB tail; the totals
    // capture the original size). For older completed rows the migration
    // backfilled totals to length(stored), so callers can always rely on
    // the *_total_bytes field. *_bytes still reflects what's *stored*.
    const selectList = includeOutput
      ? "r.*, c.name as cron_name, c.command as cron_command"
      : `r.id, r.project_id, r.cron_id, r.started_at, r.finished_at,
         r.exit_code, r.duration_ms,
         length(CAST(COALESCE(r.stdout, '') AS BLOB)) AS stdout_bytes,
         length(CAST(COALESCE(r.stderr, '') AS BLOB)) AS stderr_bytes,
         COALESCE(r.stdout_total_bytes, length(CAST(COALESCE(r.stdout, '') AS BLOB))) AS stdout_total_bytes,
         COALESCE(r.stderr_total_bytes, length(CAST(COALESCE(r.stderr, '') AS BLOB))) AS stderr_total_bytes,
         c.name as cron_name, c.command as cron_command`;

    // Order by ms timestamp so a build that started in the same second as a
    // prior run still sorts predictably. moor_run_get's "tail the most recent
    // in-flight build" pattern relies on this. id DESC tie-breaks when even
    // the ms collides (back-to-back inserts on a fast host). COALESCE guards
    // against any row that somehow predated the started_at_ms backfill.
    const rows = db
      .query(
        `SELECT ${selectList}
         FROM runs r
         LEFT JOIN crons c ON c.id = r.cron_id
         WHERE r.project_id = ?
         ORDER BY COALESCE(r.started_at_ms, 0) DESC, r.id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(projectId, PAGE_SIZE, offset);

    const { total } = db
      .query("SELECT COUNT(*) as total FROM runs WHERE project_id = ?")
      .get(projectId) as { total: number };

    return Response.json({ runs: rows, total });
  }

  // /api/projects/:id/build-output
  const buildMatch = url.pathname.match(/^\/api\/projects\/(\d+)\/build-output$/);
  if (buildMatch && req.method === "GET") {
    const projectId = Number(buildMatch[1]);
    const row = db
      .query(
        `SELECT * FROM runs
         WHERE project_id = ? AND cron_id IS NULL
         ORDER BY COALESCE(started_at_ms, 0) DESC, id DESC
         LIMIT 1`,
      )
      .get(projectId);

    if (!row) return Response.json({ output: null });
    return Response.json(row);
  }

  // /api/runs/:id
  const runMatch = url.pathname.match(/^\/api\/runs\/(\d+)$/);
  if (runMatch && req.method === "GET") {
    const id = Number(runMatch[1]);
    const row = db
      .query(
        `SELECT r.*, c.name as cron_name, c.command as cron_command
         FROM runs r
         LEFT JOIN crons c ON c.id = r.cron_id
         WHERE r.id = ?`,
      )
      .get(id);

    if (!row) return new Response("Not found", { status: 404 });
    return Response.json(row);
  }

  // /api/runs/:id/stop — generalized to cover cron runs (existing) and
  // active build/pull runs (#68). Lookup order matters: cron registry
  // first, then build registry, then DB to disambiguate "already
  // finished" from "doesn't exist". We don't infer "is build vs cron"
  // from the DB row because cron_id IS NULL is ambiguous (deleted
  // crons also have NULL via ON DELETE SET NULL).
  const stopMatch = url.pathname.match(/^\/api\/runs\/(\d+)\/stop$/);
  if (stopMatch && req.method === "POST") {
    const id = Number(stopMatch[1]);

    const stoppedCron = await stopCronRun(id);
    if (stoppedCron) {
      return Response.json({ ok: true, result: "cancelled_cron" });
    }

    const build = activeBuildRuns.get(id);
    if (build) {
      const result = build.cancel();
      if (result === "cancelled") {
        return Response.json({ ok: true, result: "cancelled" });
      }
      // not_cancellable / already_finished — caller can still tell what
      // happened from the result field.
      return Response.json({ ok: false, result }, { status: 409 });
    }

    // Not in either registry. Differentiate "doesn't exist" from
    // "exists but already terminal" so the operator can tell whether
    // they hit the right id.
    const row = db.query("SELECT finished_at FROM runs WHERE id = ?").get(id) as {
      finished_at: string | null;
    } | null;
    if (!row) {
      return Response.json({ ok: false, result: "not_found" }, { status: 404 });
    }
    if (row.finished_at !== null) {
      return Response.json({ ok: false, result: "already_finished" }, { status: 409 });
    }
    // Row exists, in-flight, but neither registry knows about it. Most
    // likely an orphan that the next moor restart would sweep — treat as
    // not_active so the operator knows it can't be cancelled here.
    return Response.json({ ok: false, result: "not_active" }, { status: 409 });
  }

  return null;
}
