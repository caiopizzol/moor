import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { appendStream, formatMs } from "../format";
import type { ToolContext } from "./context";
export function registerExecTools(server: McpServer, client: ToolContext): void {
  const { apiResponse, resolveProject, readErrorMessage } = client;

  server.registerTool(
    "moor_exec",
    {
      title: "Execute Command",
      description:
        "Run a shell command inside a project's running container. Bounded by a per-call timeout (default 10 min, max 1 h). For jobs that may exceed an hour, use moor_exec_async.",
      inputSchema: z.object({
        project: z.string().describe("Project name or ID"),
        command: z.string().describe("Shell command to execute"),
        timeout_ms: z
          .number()
          .int()
          .min(1000)
          .max(3_600_000)
          .optional()
          .describe(
            "Max time in milliseconds before the exec is aborted. Default 600000 (10 min). Max 3600000 (1 h).",
          ),
      }),
    },
    async ({ project, command, timeout_ms }) => {
      const p = await resolveProject(project);
      const body: Record<string, unknown> = { command };
      if (timeout_ms !== undefined) body.timeout_ms = timeout_ms;
      const res = await apiResponse.post(`/api/projects/${p.id}/exec`, body);
      // The API returns 504 with a structured timeout body when the exec hit
      // timeout_ms. Surface the kill outcome in the tool error so the agent can
      // tell "the process was actually stopped" from "we just stopped waiting."
      if (res.status === 504) {
        const t = (await res.json()) as {
          timeout_ms: number;
          killed: boolean;
          killed_pid: string | null;
          live_remaining: number;
          message: string;
        };
        let detail: string;
        if (t.killed) {
          detail = `Process tree terminated (container pid ${t.killed_pid}).`;
        } else if (t.killed_pid !== null) {
          detail = `Kill attempted on container pid ${t.killed_pid} but ${t.live_remaining} descendant process(es) still running inside the container.`;
        } else {
          detail =
            "Process kill could not locate the running process — it may still be running inside the container.";
        }
        throw new Error(`Exec timed out after ${t.timeout_ms}ms. ${detail}`);
      }
      if (!res.ok) throw new Error(`Failed: ${await readErrorMessage(res)}`);
      const result = (await res.json()) as {
        exitCode: number;
        stdout: string;
        stderr: string;
      };
      let text = "";
      if (result.stdout) text += result.stdout;
      if (result.stderr) text += `\n[stderr] ${result.stderr}`;
      text += `\n[exit code: ${result.exitCode}]`;
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "moor_exec_async",
    {
      title: "Start Async Exec",
      description:
        "Run a long-lived command inside a project's container, returning immediately with a run_id. Use moor_exec_status to poll for output and exit code; moor_exec_stop to terminate. Bounded by an optional timeout_ms (default 86400000 = 24h; min 60000 = 1 min; max 86400000). The recorded output is tail-truncated to the last 64 KiB per stream; stdout_total_bytes and stderr_total_bytes report the full pre-truncation byte count.",
      inputSchema: z.object({
        project: z.string().describe("Project name or ID"),
        command: z.string().min(1).describe("Shell command to execute"),
        timeout_ms: z
          .number()
          .int()
          .min(60_000)
          .max(86_400_000)
          .optional()
          .describe(
            "Safety timeout in milliseconds. When exceeded, the process tree is terminated and the run is marked timed_out. Default 86400000 (24h). Min 60000. Max 86400000.",
          ),
      }),
    },
    async ({ project, command, timeout_ms }) => {
      const p = await resolveProject(project);
      const body: Record<string, unknown> = { command };
      if (timeout_ms !== undefined) body.timeout_ms = timeout_ms;
      const res = await apiResponse.post(`/api/projects/${p.id}/exec/async`, body);
      if (!res.ok) throw new Error(`Failed: ${await readErrorMessage(res)}`);
      const data = (await res.json()) as { run_id: number };
      return {
        content: [
          {
            type: "text",
            text: `Started async exec on ${p.name}. run_id=${data.run_id}. Use moor_exec_status to poll; moor_exec_stop to terminate.`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "moor_exec_status",
    {
      title: "Get Async Exec Status",
      description:
        "Return the current state of an async exec run: state, exit code (when finished), running tail of stdout/stderr (default 8 KiB each inline; the API stores up to 64 KiB), total bytes seen, duration, and any error message. State is one of: running, exited, stopped, timed_out, error. Pass tail_bytes to control how many bytes of each stream are returned inline (0 to 65536; default 8192). The API's 64 KiB-per-stream storage cap is unchanged — tail_bytes only controls what the MCP tool returns to keep responses under typical agent token limits.",
      inputSchema: z.object({
        run_id: z.number().int().positive().describe("Run ID returned by moor_exec_async"),
        tail_bytes: z
          .number()
          .int()
          .min(0)
          .max(65_536)
          .optional()
          .describe(
            "Max bytes of each stream (stdout, stderr) returned inline. Default 8192. Max 65536 (the API storage cap). Set to 0 for metadata-only.",
          ),
      }),
    },
    async ({ run_id, tail_bytes }) => {
      const cap = tail_bytes ?? 8192;
      const res = await apiResponse.get(`/api/exec/${run_id}`);
      if (res.status === 404) throw new Error(`run_id ${run_id} not found`);
      if (!res.ok) throw new Error(`Failed: ${await readErrorMessage(res)}`);
      const data = (await res.json()) as {
        id: number;
        state: string;
        exit_code: number | null;
        stdout: string;
        stderr: string;
        stdout_total_bytes: number;
        stderr_total_bytes: number;
        duration_ms: number;
        command: string;
        killed_pid: string | null;
        error_message: string | null;
        started_at: string;
        finished_at: string | null;
      };
      const lines: string[] = [];
      lines.push(
        `run_id=${data.id} state=${data.state} duration=${formatMs(data.duration_ms)}` +
          (data.exit_code !== null ? ` exit_code=${data.exit_code}` : ""),
      );
      lines.push(`command: ${data.command}`);
      if (data.killed_pid) lines.push(`killed_pid: ${data.killed_pid}`);
      if (data.error_message) lines.push(`error: ${data.error_message}`);
      appendStream(lines, "stdout", data.stdout, data.stdout_total_bytes, cap);
      appendStream(lines, "stderr", data.stderr, data.stderr_total_bytes, cap);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  server.registerTool(
    "moor_exec_stop",
    {
      title: "Stop Async Exec",
      description:
        "Terminate a running async exec by run_id. Walks the descendant process tree inside the container and sends SIGTERM then SIGKILL. Always transitions the run to a terminal state: state=stopped on clean termination (all descendants gone), state=error if any descendant survived OR if the kill handle was lost (moor restart, missing pidfile). Stop is NOT retry-safe — the kill script removes the pidfile after every attempt, and reparented survivors are unreachable from the original PID.",
      inputSchema: z.object({
        run_id: z.number().int().positive().describe("Run ID returned by moor_exec_async"),
      }),
    },
    async ({ run_id }) => {
      const res = await apiResponse.post(`/api/exec/${run_id}/stop`);
      if (res.status === 404) throw new Error(`run_id ${run_id} not found`);
      const data = (await res.json()) as {
        ok: boolean;
        state: string;
        killed_pid: string | null;
        live_remaining: number;
        message: string;
      };
      return {
        content: [
          {
            type: "text",
            text: `run_id=${run_id} state=${data.state} ${data.message}`,
          },
        ],
      };
    },
  );
}
