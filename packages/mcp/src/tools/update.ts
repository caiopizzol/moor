import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  MAX_LOG_TAIL_BYTES,
  renderAuditList,
  type UpdateAuditApiRow,
} from "../update-audit-render";
import type { ToolContext } from "./context";
export function registerUpdateTools(server: McpServer, client: ToolContext): void {
  const { apiResponse, readErrorMessage } = client;

  server.registerTool(
    "moor_update_status",
    {
      title: "Update status / preflight",
      description:
        "Report moor's current version + image digest, the latest available digest on GHCR, active in-flight work counts, DB backup recency, and a safe_to_update boolean. update_available is null (not false) when either the local repo_digest or the registry digest is unknown — never lies by comparing across identifier spaces. unsafe_reasons is a human-readable array; render inline rather than re-deriving from booleans. Read-only diagnostic — does NOT perform any update.",
    },
    async () => {
      const res = await apiResponse.get("/api/server/update-status");
      if (!res.ok) throw new Error(`Failed: ${res.status} ${await readErrorMessage(res)}`);
      const s = (await res.json()) as {
        current: {
          version: string;
          image_id: string | null;
          repo_digest: string | null;
          started_at: string;
        };
        available: {
          latest_tag: string;
          latest_digest: string | null;
          update_available: boolean | null;
          registry_error: string | null;
        };
        active_work: {
          builds_in_flight: number;
          execs_in_flight: number;
          crons_in_flight: number;
          terminals_open: number;
        };
        db_backup: {
          last_backup_at: string | null;
          age_seconds: number | null;
          location: string | null;
        };
        safe_to_update: boolean;
        unsafe_reasons: string[];
        recommended_command: string;
      };
      const lines: string[] = [];
      lines.push(`moor ${s.current.version} (image_id: ${s.current.image_id ?? "unknown"})`);
      lines.push(
        `repo_digest: ${s.current.repo_digest ?? "(none — locally built or stale inspect)"}`,
      );

      if (s.available.update_available === true) {
        lines.push(`update AVAILABLE → latest: ${s.available.latest_digest}`);
      } else if (s.available.update_available === false) {
        lines.push(`up to date (latest: ${s.available.latest_digest})`);
      } else {
        // null — explain WHICH side is unknown.
        const why = s.available.registry_error
          ? `registry unreachable: ${s.available.registry_error}`
          : s.current.repo_digest === null
            ? "no local repo_digest (built locally?)"
            : "comparison unavailable";
        lines.push(`update availability unknown — ${why}`);
      }

      lines.push(
        `active: builds=${s.active_work.builds_in_flight} execs=${s.active_work.execs_in_flight} crons=${s.active_work.crons_in_flight} terminals=${s.active_work.terminals_open}`,
      );

      if (s.safe_to_update) {
        lines.push("safe_to_update: YES");
      } else {
        lines.push("safe_to_update: NO");
        for (const r of s.unsafe_reasons) lines.push(`  - ${r}`);
      }
      lines.push(`recommended: ${s.recommended_command}`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  server.registerTool(
    "moor_update_apply",
    {
      title: "Apply moor update (transient respawner)",
      description:
        "Update moor in-place via a transient respawner container. Runs preflight, enables drain, takes a fresh DB backup, then launches a one-shot Compose-aware respawner that pulls + re-creates the moor service. The respawner writes a marker file when done; this tool returns the audit_id immediately so the caller can poll via moor_update_audit. Outcomes: success | failed (pull failed pre-replacement) | rolled_back (up/health failed, automatic rollback succeeded) | rollback_failed (rollback also failed — manual recovery needed) | crashed (no marker after 30-min grace). Bypass is per-blocker: pass {bypass:['active_work']} to interrupt in-flight builds/execs/crons via the existing shutdown coordinator; {bypass:['unknown_digest']} when the registry comparison was inconclusive. Backup is mandatory and not bypassable.",
      inputSchema: z.object({
        target_digest: z
          .string()
          .regex(/^sha256:[0-9a-f]{64}$/, "target_digest must be sha256:<64 hex>")
          .optional()
          .describe(
            "Pin the update to this exact image digest. Default: the registry's current `:latest` digest from moor_update_status.",
          ),
        bypass: z
          .array(z.enum(["active_work", "unknown_digest"]))
          .optional()
          .describe(
            "Per-blocker bypass. `active_work` accepts that in-flight builds/execs/crons will be interrupted via the shutdown coordinator. `unknown_digest` accepts proceeding when the registry comparison is inconclusive (locally-built image, GHCR unreachable). Backup is mandatory and not in this list.",
          ),
      }),
    },
    async (input) => {
      const res = await apiResponse.post("/api/server/update/apply", input ?? {});
      if (res.status === 202) {
        const { audit_id } = (await res.json()) as { audit_id: number };
        return {
          content: [
            {
              type: "text",
              text: `Update started: audit_id=${audit_id}. Respawner is running async. Poll moor_update_audit to watch the outcome, or moor_update_status to watch the version. Possible terminal states:
    - success         (new image healthy)
    - failed          (pull failed before moor was replaced)
    - rolled_back     (up/health failed; automatic rollback succeeded; drain stays on)
    - rollback_failed (up/health failed AND rollback failed; manual recovery)
    - crashed         (no marker after 30-min grace; respawner died)
  Recovery: rolled_back means moor is on the previous image again; the failed update is captured in error_log. rollback_failed or crashed mean an operator should investigate (likely manual docker compose up).`,
            },
          ],
        };
      }
      // Error: surface the structured reason so callers can act on it.
      const body = (await res.json().catch(() => ({}))) as {
        error?: { code: string; reason?: string; unsafe_reasons?: string[] };
      };
      const code = body.error?.code ?? `HTTP ${res.status}`;
      const reason = body.error?.reason ?? "no detail";
      const extra = body.error?.unsafe_reasons
        ? `\nunsafe_reasons:\n  - ${body.error.unsafe_reasons.join("\n  - ")}`
        : "";
      throw new Error(`moor_update_apply refused [${code}]: ${reason}${extra}`);
    },
  );

  server.registerTool(
    "moor_update_audit",
    {
      title: "Update history (audit log)",
      description:
        "Read-only: recent moor_update_apply attempts and their outcomes. Each row shows audit_id, state (success | failed | rolled_back | rollback_failed | in_progress | crashed), duration, digest deltas, backup path, and any error logs. error_log preserves the ORIGINAL apply failure (never overwritten by rollback step details); rollback_error is set only on rollback_failed. Default tail is 4 KiB per log field; pass tail_bytes=0 to omit log bodies entirely (keeps the metadata line and replaces the body with a sized marker), or up to 16384 to read more.",
      inputSchema: z.object({
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("How many most-recent attempts to return. Default 20, max 200."),
        tail_bytes: z
          .number()
          .int()
          .min(0)
          .max(MAX_LOG_TAIL_BYTES)
          .optional()
          .describe(
            "Max bytes of error_log and rollback_error returned inline per row. Default 4096 (4 KiB). 0 to omit log bodies entirely; 16384 max.",
          ),
      }),
    },
    async ({ limit, tail_bytes }) => {
      const qs = new URLSearchParams();
      if (limit !== undefined) qs.set("limit", String(limit));
      const path = qs.toString()
        ? `/api/server/update/audit?${qs.toString()}`
        : "/api/server/update/audit";
      const res = await apiResponse.get(path);
      if (!res.ok)
        throw new Error(`update audit failed: ${res.status} ${await readErrorMessage(res)}`);
      const { rows } = (await res.json()) as { rows: UpdateAuditApiRow[] };
      return {
        content: [{ type: "text", text: renderAuditList(rows, { tail_bytes }) }],
      };
    },
  );
}
