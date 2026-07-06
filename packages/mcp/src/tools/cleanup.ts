import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { formatBytes } from "../format";
import type { ToolContext } from "./context";
export function registerCleanupTools(server: McpServer, client: ToolContext): void {
  const { apiResponse, readErrorMessage } = client;

  server.registerTool(
    "moor_cleanup_plan",
    {
      title: "Cleanup Plan (dry-run)",
      description:
        "Dry-run: list Docker resources that are safe to delete on this host. v1 covers build cache (host-wide prune) and dangling images (per-ID). Returns candidates with reclaimable bytes. Pass the same candidate list to moor_cleanup_execute to actually delete. No state is kept between plan and execute — execute re-validates eligibility against current Docker state.",
      inputSchema: z.object({
        scope: z
          .array(z.enum(["build_cache", "dangling_image"]))
          .optional()
          .describe("Subset of categories to plan. Defaults to all v1 categories."),
      }),
    },
    async ({ scope }) => {
      const res = await apiResponse.post("/api/server/cleanup/plan", { scope });
      if (!res.ok) throw new Error(`plan failed: ${res.status} ${await readErrorMessage(res)}`);
      const data = (await res.json()) as {
        candidates: Array<
          | { category: "build_cache"; reclaimable_bytes: number; label: string }
          | {
              category: "dangling_image";
              id: string;
              reclaimable_bytes: number;
              repo_tags: string[];
              label: string;
            }
        >;
        total_reclaimable_bytes: number;
      };
      if (data.candidates.length === 0) {
        return { content: [{ type: "text", text: "Nothing to clean up." }] };
      }
      const lines = [
        `${data.candidates.length} candidate(s), total reclaimable: ${formatBytes(data.total_reclaimable_bytes)}.`,
        "Pass the candidates_json block below back to moor_cleanup_execute to delete.",
        "",
      ];
      for (const c of data.candidates) {
        if (c.category === "build_cache") {
          lines.push(
            `build_cache [${c.label}] — ${formatBytes(c.reclaimable_bytes)} reclaimable (host-wide prune)`,
          );
        } else {
          const tags = c.repo_tags.length > 0 ? ` tags=${c.repo_tags.join(",")}` : "";
          lines.push(
            `dangling_image [${c.label}] id=${c.id} ${formatBytes(c.reclaimable_bytes)}${tags}`,
          );
        }
      }
      // Emit candidates_json so the agent doesn't have to reconstruct identifiers
      // from the prose lines above. The execute side ignores extra fields, so
      // passing the whole candidate objects (label, reclaimable_bytes, etc.) is
      // safe — server re-validates eligibility and computes actual freed bytes.
      lines.push("", "candidates_json:", JSON.stringify(data.candidates, null, 2));
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  server.registerTool(
    "moor_cleanup_execute",
    {
      title: "Cleanup Execute",
      description:
        "Delete the candidates returned by moor_cleanup_plan. Server uses only the identifying fields (category + id where applicable) and re-validates eligibility against current Docker state immediately before each delete — Docker state can change between plan and execute. Reclaimable byte estimates from plan are ignored; the server reports the actual freed bytes. Every execute writes an audit row.",
      inputSchema: z.object({
        candidates: z
          .array(
            z.union([
              z.object({ category: z.literal("build_cache") }).passthrough(),
              z
                .object({ category: z.literal("dangling_image"), id: z.string().min(1) })
                .passthrough(),
            ]),
          )
          .min(1)
          .describe("Candidates from moor_cleanup_plan. Extra fields are ignored server-side."),
      }),
    },
    async ({ candidates }) => {
      const res = await apiResponse.post("/api/server/cleanup/execute", { candidates });
      if (!res.ok) throw new Error(`execute failed: ${res.status} ${await readErrorMessage(res)}`);
      const data = (await res.json()) as {
        audit_id: number;
        total_reclaimed_bytes: number;
        results: Array<
          | { category: "build_cache"; reclaimed_bytes: number; error: string | null }
          | {
              category: "dangling_image";
              id: string;
              reclaimed_bytes: number;
              error: string | null;
            }
        >;
      };
      const lines = [
        `audit_id=${data.audit_id} total_reclaimed=${formatBytes(data.total_reclaimed_bytes)}`,
        "",
      ];
      for (const r of data.results) {
        const status = r.error ? `ERROR: ${r.error}` : "ok";
        if (r.category === "build_cache") {
          lines.push(`build_cache: reclaimed=${formatBytes(r.reclaimed_bytes)} ${status}`);
        } else {
          lines.push(
            `dangling_image id=${r.id} reclaimed=${formatBytes(r.reclaimed_bytes)} ${status}`,
          );
        }
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );
}
