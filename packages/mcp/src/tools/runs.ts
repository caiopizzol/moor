import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { appendStream, deriveRunStatus, deriveRunType, formatMsShort } from "../format";
import type { ToolContext } from "./context";
export function registerRunTools(server: McpServer, client: ToolContext): void {
  const { apiResponse, resolveProject, readErrorMessage, readSSE } = client;

  server.registerTool(
    "moor_logs",
    {
      title: "Get Container Logs",
      description:
        "Get recent logs from a project's container. Annotates output with state: ok (container running), exited (container is stopped but Docker still has logs), no_container (project never started), or missing (container_id is set but Docker doesn't have it). Throws only on docker_error (Docker daemon 5xx / unreachable) so an operator can distinguish infrastructure failure from app silence — pre-#74 the tool returned empty logs for all of these.",
      inputSchema: z.object({
        project: z.string().describe("Project name or ID"),
        lines: z.number().optional().default(100).describe("Number of log lines to retrieve"),
      }),
    },
    async ({ project, lines }) => {
      const p = await resolveProject(project);
      const res = await apiResponse.get(`/api/projects/${p.id}/logs?tail=${lines}`);
      // 502 = API surfaced a Docker daemon failure. Throw so the agent
      // gets a tool error, not silent empty logs.
      if (res.status === 502) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(`Docker error: ${data.error ?? "unknown"}`);
      }
      if (!res.ok) throw new Error(`Failed: ${res.status} ${await readErrorMessage(res)}`);
      const data = (await res.json()) as { logs: string; state?: string };
      switch (data.state) {
        case "no_container":
          return {
            content: [{ type: "text", text: "(project hasn't been started yet — no container)" }],
          };
        case "missing":
          return {
            content: [
              {
                type: "text",
                text: "(container_id was recorded but Docker doesn't have it; moor may need to recreate the project)",
              },
            ],
          };
        case "exited":
          return {
            content: [
              {
                type: "text",
                text: `${data.logs || "(no logs captured)"}\n\n(container is exited; logs above are from before)`,
              },
            ],
          };
        default:
          // "ok" or undefined (older API) — render raw.
          return {
            content: [{ type: "text", text: data.logs || "(no logs)" }],
          };
      }
    },
  );

  server.registerTool(
    "moor_rebuild",
    {
      title: "Rebuild Project",
      description:
        "Rebuild a project from source (git pull + docker build) and restart the container. Returns the build output when it finishes. While a build is in flight, the most recent moor_runs entry has finished_at=null — call moor_run_get on its id to tail the live output. Use moor_rebuild for code, Dockerfile, or base-image changes. For env vars / resource limits / port / volume / restart-policy changes, or to recover a crashed container from the existing image, use moor_restart — it skips the build and is much faster.",
      inputSchema: z.object({
        project: z.string().describe("Project name or ID"),
        no_cache: z.boolean().optional().default(false).describe("Build without Docker cache"),
      }),
    },
    async ({ project, no_cache }) => {
      const p = await resolveProject(project);
      const query = no_cache ? "?nocache=true" : "";
      const res = await apiResponse.post(`/api/projects/${p.id}/run${query}`);
      // /run can fail BEFORE opening the SSE stream — resolver validation,
      // drain mode, invalid URL, credential_not_active. Those land as a
      // plain JSON or text body that readSSE walks without matching any
      // event:/data: lines, returning empty everything. Without this guard
      // the tool would silently report "Rebuild complete." on a failed build.
      // Mirrors the existing moor_deploy guard at the /run call site.
      if (!res.ok) throw new Error(`[run] ${await readErrorMessage(res)}`);
      const { logs, error, structuredError } = await readSSE(res);
      // #119: a classified failure (today: source_credential_required) gets
      // returned as isError with a structured payload the agent can branch
      // on. Unclassified errors keep throwing so the existing UX is preserved.
      if (structuredError) {
        return {
          content: [
            {
              type: "text",
              text: `rebuild failed: code=${structuredError.code} message=${structuredError.message}`,
            },
          ],
          structuredContent: structuredError,
          isError: true,
        };
      }
      if (error) throw new Error(error);
      return { content: [{ type: "text", text: logs || "Rebuild complete." }] };
    },
  );

  server.registerTool(
    "moor_restart",
    {
      title: "Restart Project",
      description:
        "Stop and recreate a project's container from its existing image. Does NOT pull from git or rebuild — uses the existing image_tag. Right tool for: applying changed env vars / resource limits / ports / volumes / restart policy, recovering a crashed container, or simply bouncing the process. Wrong tool for: code or Dockerfile changes (use moor_rebuild — those need a new image).",
      inputSchema: z.object({
        project: z.string().describe("Project name or ID"),
      }),
    },
    async ({ project }) => {
      const p = await resolveProject(project);
      const res = await apiResponse.post(`/api/projects/${p.id}/restart`);
      if (!res.ok) throw new Error(`Failed to restart: ${await readErrorMessage(res)}`);
      return { content: [{ type: "text", text: `${p.name} restarted.` }] };
    },
  );

  server.registerTool(
    "moor_runs",
    {
      title: "List Project Run History",
      description:
        "Paginated list of cron runs and build runs for a project. Returns one compact line per run (id, type, status, exit code, duration, output byte counts, timestamps) — stdout/stderr bodies are NOT included to avoid blowing token budgets on large build outputs. Use moor_run_get(run_id) to fetch the stored output for a single run (cron rows store full output; build/manual rows store at most a 64 KiB tail with the original total bytes recorded separately).",
      inputSchema: z.object({
        project: z.string().describe("Project name or ID"),
        page: z
          .number()
          .int()
          .positive()
          .optional()
          .default(1)
          .describe("Page number (20 runs per page). Default 1."),
      }),
    },
    async ({ project, page }) => {
      const p = await resolveProject(project);
      const res = await apiResponse.get(
        `/api/projects/${p.id}/runs?include_output=false&page=${page}`,
      );
      if (!res.ok) throw new Error(`Failed: ${await readErrorMessage(res)}`);
      const data = (await res.json()) as {
        runs: Array<{
          id: number;
          cron_id: number | null;
          cron_name: string | null;
          cron_command: string | null;
          started_at: string;
          finished_at: string | null;
          exit_code: number | null;
          duration_ms: number | null;
          stdout_bytes: number;
          stderr_bytes: number;
          stdout_total_bytes?: number;
          stderr_total_bytes?: number;
        }>;
        total: number;
      };
      if (data.runs.length === 0) {
        return {
          content: [{ type: "text", text: `No runs recorded for ${p.name}.` }],
        };
      }
      const lines: string[] = [];
      lines.push(
        `${p.name}: ${data.runs.length} run(s) on page ${page}, ${data.total} total. Use moor_run_get(run_id) for stored output (build/manual rows are tail-truncated; total bytes shown below).`,
      );
      for (const r of data.runs) {
        const type = deriveRunType(r);
        const status = deriveRunStatus(r);
        const exit = r.exit_code != null ? ` exit=${r.exit_code}` : "";
        const cmd = r.cron_command ? ` cmd="${r.cron_command}"` : "";
        // #65: surface "what was emitted" (total) per byte field. For live or
        // already-truncated build runs total > stored; for crons and historical
        // build rows they're equal. Showing total is the operationally useful
        // number — "what did Docker actually produce" — and stays accurate as a
        // build streams in. Fall back to stdout_bytes if the API is old.
        const outTotal = r.stdout_total_bytes ?? r.stdout_bytes;
        const errTotal = r.stderr_total_bytes ?? r.stderr_bytes;
        lines.push(
          `id=${r.id} ${type} ${status}${exit} dur=${formatMsShort(r.duration_ms)} stdout=${outTotal}B stderr=${errTotal}B started=${r.started_at}${cmd}`,
        );
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  server.registerTool(
    "moor_run_get",
    {
      title: "Get Run Detail",
      description:
        "Fetch one cron or build run with its stdout and stderr. Output is tail-truncated (default 8 KiB per stream; max 65536) to keep responses under typical agent token limits. Use tail_bytes=0 for metadata-only.",
      inputSchema: z.object({
        run_id: z.number().int().positive().describe("Run ID returned by moor_runs"),
        tail_bytes: z
          .number()
          .int()
          .min(0)
          .max(65_536)
          .optional()
          .describe(
            "Max bytes of each stream returned inline. Default 8192. Max 65536. Set to 0 for metadata-only.",
          ),
      }),
    },
    async ({ run_id, tail_bytes }) => {
      const cap = tail_bytes ?? 8192;
      const res = await apiResponse.get(`/api/runs/${run_id}`);
      if (res.status === 404) throw new Error(`run_id ${run_id} not found`);
      if (!res.ok) throw new Error(`Failed: ${await readErrorMessage(res)}`);
      const r = (await res.json()) as {
        id: number;
        cron_id: number | null;
        cron_name: string | null;
        cron_command: string | null;
        started_at: string;
        finished_at: string | null;
        exit_code: number | null;
        duration_ms: number | null;
        stdout: string | null;
        stderr: string | null;
        stdout_total_bytes?: number | null;
        stderr_total_bytes?: number | null;
      };
      const lines: string[] = [];
      const type = deriveRunType(r);
      const status = deriveRunStatus(r);
      const exit = r.exit_code != null ? ` exit_code=${r.exit_code}` : "";
      lines.push(
        `run_id=${r.id} ${type} ${status}${exit} duration=${formatMsShort(r.duration_ms)}`,
      );
      if (r.cron_command) lines.push(`cron_command: ${r.cron_command}`);
      lines.push(`started_at: ${r.started_at}`);
      if (r.finished_at) lines.push(`finished_at: ${r.finished_at}`);
      // #65: runs.stdout/stderr for build runs is a server-side 64 KiB tail
      // (TAIL_CAP_BYTES). Use stdout_total_bytes / stderr_total_bytes when the
      // API provides them so appendStream can honestly report "last X of Y".
      // For cron rows the stored payload IS the full output, and total == stored.
      // Fall back to encoded length for older APIs that don't return the totals.
      const stdoutStr = r.stdout ?? "";
      const stderrStr = r.stderr ?? "";
      const enc = new TextEncoder();
      const stdoutTotal = r.stdout_total_bytes ?? enc.encode(stdoutStr).length;
      const stderrTotal = r.stderr_total_bytes ?? enc.encode(stderrStr).length;
      appendStream(lines, "stdout", stdoutStr, stdoutTotal, cap);
      appendStream(lines, "stderr", stderrStr, stderrTotal, cap);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  server.registerTool(
    "moor_run_stop",
    {
      title: "Stop or Cancel a Run",
      description:
        "Stops an active cron run or cancels an active build/pull run (from moor_rebuild / moor_deploy). Closing the connection to the Docker build/pull endpoint aborts the daemon-side job. Cancellation is only valid during the build/pull streaming phase — once the build finishes and container start has begun, the call returns not_cancellable. Returns one of: cancelled, cancelled_cron, not_cancellable, already_finished, not_active, not_found. These are all expected outcomes, not errors — the tool throws only on unexpected server failures.",
      inputSchema: z.object({
        run_id: z.number().int().positive().describe("Run ID from moor_runs"),
      }),
    },
    async ({ run_id }) => {
      const res = await apiResponse.post(`/api/runs/${run_id}/stop`);
      // The /stop route returns 200 for cancelled/cancelled_cron and 4xx
      // for the rest of the known result categories (with a result field
      // either way). All of those are expected outcomes — render them as
      // content so the agent can react without try/catch. Only surface as
      // an error if the response doesn't fit the documented shape (server
      // error, parse failure, etc).
      let data: { ok?: boolean; result?: string; error?: string };
      try {
        data = (await res.json()) as { ok?: boolean; result?: string; error?: string };
      } catch {
        throw new Error(`run_id=${run_id} server error: ${res.status} ${res.statusText}`);
      }
      if (typeof data.result === "string") {
        return { content: [{ type: "text", text: `run_id=${run_id} ${data.result}` }] };
      }
      throw new Error(
        `run_id=${run_id} unexpected response: status=${res.status} body=${JSON.stringify(data)}`,
      );
    },
  );
}
