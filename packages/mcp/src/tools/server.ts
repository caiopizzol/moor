import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { type DrainState, formatBytes, renderDrainState } from "../format";
import type { ToolContext } from "./context";
export function registerServerTools(server: McpServer, client: ToolContext): void {
  const { apiResponse, resolveProject, readErrorMessage } = client;

  server.registerTool(
    "moor_stats",
    {
      title: "Server Stats",
      description:
        "Get server resource usage: load, memory, per-filesystem disk usage (the filesystems the moor container can see, plus any operator-configured monitored host disks via MOOR_MONITORED_DISKS), Docker disk by category (images/containers/volumes/build cache) with reclaimable bytes, and container counts. Note: cpu.percent is load-derived (load avg ÷ cores), not instantaneous CPU; use the `load` field for the same signal with explicit naming.",
    },
    async () => {
      const res = await apiResponse.get("/api/server/stats");
      if (!res.ok) throw new Error(`Failed: ${res.status}`);
      const s = (await res.json()) as {
        hostname: string;
        os: string;
        uptime: string;
        cpu: { percent: number; cores: number };
        load?: { one_min: number; cores: number; normalized_percent: number };
        memory: { total: string; used: string; percent: number };
        disk: { total: string; used: string; percent: number };
        disks?: { mount: string; total: string; used: string; percent: number; label?: string }[];
        containers: { running: number; total: number };
        docker?: {
          images: { bytes: number; reclaimable_bytes: number; count: number; unused_count: number };
          containers: {
            bytes: number;
            reclaimable_bytes: number;
            count: number;
            stopped_count: number;
          };
          volumes: {
            bytes: number;
            reclaimable_bytes: number;
            count: number;
            unused_count: number;
          };
          build_cache: { bytes: number; reclaimable_bytes: number; count: number };
        } | null;
      };
      const lines = [
        `Host: ${s.hostname}`,
        `OS: ${s.os}`,
        `Uptime: ${s.uptime}`,
        `CPU: ${s.cpu.percent}% (${s.cpu.cores} cores) — load-derived, not instantaneous`,
      ];
      if (s.load) {
        lines.push(
          `Load (1m): ${s.load.one_min.toFixed(2)} on ${s.load.cores} cores (${s.load.normalized_percent}%)`,
        );
      }
      lines.push(`Memory: ${s.memory.used} / ${s.memory.total} (${s.memory.percent}%)`);
      const disks = s.disks?.length ? s.disks : [{ mount: "/", ...s.disk }];
      for (const d of disks) {
        const name = d.label ? `${d.label} (${d.mount})` : `Disk ${d.mount}`;
        lines.push(`${name}: ${d.used} / ${d.total} (${d.percent}%)`);
      }
      lines.push(`Containers: ${s.containers.running} running / ${s.containers.total} total`);
      if (s.docker) {
        const d = s.docker;
        lines.push(
          "Docker disk:",
          `  Images: ${formatBytes(d.images.bytes)} (${formatBytes(d.images.reclaimable_bytes)} reclaimable, ${d.images.unused_count}/${d.images.count} unused)`,
          `  Containers: ${formatBytes(d.containers.bytes)} (${formatBytes(d.containers.reclaimable_bytes)} reclaimable, ${d.containers.stopped_count}/${d.containers.count} stopped)`,
          `  Volumes: ${formatBytes(d.volumes.bytes)} (${formatBytes(d.volumes.reclaimable_bytes)} reclaimable, ${d.volumes.unused_count}/${d.volumes.count} unused)`,
          `  Build cache: ${formatBytes(d.build_cache.bytes)} (${formatBytes(d.build_cache.reclaimable_bytes)} reclaimable, ${d.build_cache.count} entries)`,
        );
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  type DrainStateResponse = {
    state: DrainState;
  };

  type DrainStatusResponse = DrainStateResponse & {
    active_work: {
      builds_in_flight: number;
      execs_in_flight: number;
      crons_in_flight: number;
      terminals_open: number;
    };
  };

  server.registerTool(
    "moor_drain_status",
    {
      title: "Drain Status",
      description:
        "Read-only: current drain state (enabled, reason, expires_at, clear_after_version) plus counts of active work the operator should wait on before an update. active_work uses the same counter as moor_update_status so the two never disagree.",
    },
    async () => {
      const res = await apiResponse.get("/api/server/drain");
      if (!res.ok)
        throw new Error(`drain status failed: ${res.status} ${await readErrorMessage(res)}`);
      const s = (await res.json()) as DrainStatusResponse;
      const lines = renderDrainState(s.state);
      lines.push(
        `active: builds=${s.active_work.builds_in_flight} execs=${s.active_work.execs_in_flight} crons=${s.active_work.crons_in_flight} terminals=${s.active_work.terminals_open}`,
      );
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  server.registerTool(
    "moor_drain_enable",
    {
      title: "Enable Drain Mode",
      description:
        "Refuse new builds, deploys, execs, manual cron runs, and terminal upgrades with a 503 carrying { reason, expires_at, hint }. Existing in-flight work runs to completion — drain does NOT kill anything. Scheduled cron ticks during drain write a synthetic 'skipped due to drain' run row instead of executing. Read-only routes (status, logs, runs) keep working. Default TTL is 30 minutes; set ttl_minutes to override. clear_after_version is the updater's hook — when set, the drain auto-clears on boot if the running moor version matches.",
      inputSchema: z.object({
        reason: z
          .string()
          .optional()
          .describe(
            "Freeform reason shown in every refusal response (e.g. 'preparing for 0.34 upgrade').",
          ),
        ttl_minutes: z
          .number()
          .optional()
          .describe(
            "Auto-clear after this many minutes. Default 30. Clamped to [0.05 min, 7 days].",
          ),
        clear_after_version: z
          .string()
          .optional()
          .describe(
            "Optional: on next boot, if the running moor version equals this value, auto-clear the drain. Typically set by the updater path; safe for manual use too.",
          ),
      }),
    },
    async ({ reason, ttl_minutes, clear_after_version }) => {
      const res = await apiResponse.post("/api/server/drain/enable", {
        reason,
        ttl_minutes,
        clear_after_version,
      });
      if (!res.ok)
        throw new Error(`drain enable failed: ${res.status} ${await readErrorMessage(res)}`);
      const s = (await res.json()) as DrainStateResponse;
      return { content: [{ type: "text", text: renderDrainState(s.state).join("\n") }] };
    },
  );

  server.registerTool(
    "moor_drain_disable",
    {
      title: "Disable Drain Mode",
      description:
        "Explicit operator action to clear drain immediately. Does not kill or restart anything — just removes the gate so new builds/deploys/execs/cron triggers/terminal upgrades succeed again.",
    },
    async () => {
      const res = await apiResponse.post("/api/server/drain/disable", {});
      if (!res.ok)
        throw new Error(`drain disable failed: ${res.status} ${await readErrorMessage(res)}`);
      const s = (await res.json()) as DrainStateResponse;
      return { content: [{ type: "text", text: renderDrainState(s.state).join("\n") }] };
    },
  );

  server.registerTool(
    "moor_db_backup",
    {
      title: "DB Backup (snapshot)",
      description:
        "Take a SQLite snapshot of moor.db via VACUUM INTO. The file lands next to the main DB as moor.db.backup-<epoch-ms>. Retention is enforced after each snapshot (keeps the 7 most recent by default; older ones are pruned). After this returns, moor_update_status' db_backup.age_seconds will read close to 0. Use before a manual `docker compose pull moor && up -d` if you don't have MOOR_DB_BACKUP_INTERVAL_HOURS scheduled.",
    },
    async () => {
      const res = await apiResponse.post("/api/server/backup", {});
      if (!res.ok)
        throw new Error(`db backup failed: ${res.status} ${await readErrorMessage(res)}`);
      const r = (await res.json()) as { path: string; sizeBytes: number; durationMs: number };
      const mb = (r.sizeBytes / (1024 * 1024)).toFixed(2);
      return {
        content: [
          {
            type: "text",
            text: `Snapshot written: ${r.path}\nsize: ${r.sizeBytes}B (${mb} MB)\nduration: ${r.durationMs}ms`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "moor_project_stats",
    {
      title: "Project Container Stats (live)",
      description:
        "Live container stats for one project: CPU percent, memory (excluding page cache, same accounting as `docker stats`), network and block I/O totals, PID count. Single Docker stats snapshot — CPU uses the cpu_stats/precpu_stats delta the daemon already includes. Stopped or never-started projects return running=false with zeroed counters (no 404).",
      inputSchema: z.object({
        project: z.string().describe("Project name or ID"),
      }),
    },
    async ({ project }) => {
      const p = await resolveProject(project);
      const res = await apiResponse.get(`/api/projects/${p.id}/container-stats`);
      if (!res.ok) throw new Error(`Failed: ${res.status} ${await readErrorMessage(res)}`);
      const s = (await res.json()) as {
        running: boolean;
        cpu_percent: number;
        memory_bytes: number;
        memory_limit_bytes: number;
        memory_percent: number;
        network_rx_bytes: number;
        network_tx_bytes: number;
        block_read_bytes: number;
        block_write_bytes: number;
        pids: number;
      };
      if (!s.running) {
        return {
          content: [{ type: "text", text: `${p.name}: not running (zeroed counters returned).` }],
        };
      }
      const memLimit = s.memory_limit_bytes > 0 ? formatBytes(s.memory_limit_bytes) : "unlimited";
      const lines = [
        `${p.name}: CPU ${s.cpu_percent}% | Memory ${formatBytes(s.memory_bytes)} / ${memLimit} (${s.memory_percent}%) | PIDs ${s.pids}`,
        `Network: rx ${formatBytes(s.network_rx_bytes)} / tx ${formatBytes(s.network_tx_bytes)}`,
        `Block I/O: read ${formatBytes(s.block_read_bytes)} / write ${formatBytes(s.block_write_bytes)}`,
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  server.registerTool(
    "moor_project_history",
    {
      title: "Project History (stored)",
      description:
        "Stored resource history + lifecycle events for one project over a time window — answers 'what was going on with this project around this case?' (NOT live: use moor_project_stats for a current snapshot). Resource samples are taken ~every minute; CPU is averaged across each interval and network/block reported as rates, both computed from raw counters and reset-aware. Events come from the Docker event stream (start/die/oom/kill/restart) and moor's own state changes. Window defaults to the last `hours` (24); pass from_ms/to_ms (epoch ms) for an exact window. A gap warning means events may be incomplete in that window.",
      inputSchema: z.object({
        project: z.string().describe("Project name or ID"),
        hours: z
          .number()
          .optional()
          .describe("Lookback window in hours (default 24). Ignored if from_ms/to_ms are given."),
        from_ms: z.number().optional().describe("Window start, epoch milliseconds"),
        to_ms: z.number().optional().describe("Window end, epoch milliseconds"),
      }),
    },
    async ({ project, hours, from_ms, to_ms }) => {
      const p = await resolveProject(project);
      const to = to_ms ?? Date.now();
      const from = from_ms ?? to - (hours ?? 24) * 3_600_000;
      const res = await apiResponse.get(
        `/api/projects/${p.id}/stats/history?from=${from}&to=${to}`,
      );
      if (!res.ok) throw new Error(`Failed: ${res.status} ${await readErrorMessage(res)}`);
      const h = (await res.json()) as {
        from_ms: number;
        to_ms: number;
        events: Array<{ occurred_at_ms: number; source: string; action: string }>;
        summary: {
          sample_count: number;
          running_sample_count: number;
          cpu_percent_avg: number | null;
          cpu_percent_max: number | null;
          mem_bytes_max: number | null;
          net_rx_bytes_total: number;
          net_tx_bytes_total: number;
          event_counts: Record<string, number>;
          has_gap: boolean;
        };
      };
      const s = h.summary;
      const windowH = Math.round(((h.to_ms - h.from_ms) / 3_600_000) * 10) / 10;
      const lines = [
        `${p.name} history — window ~${windowH}h${s.has_gap ? "  [⚠ event gap recorded: events may be incomplete]" : ""}`,
        `Samples: ${s.sample_count} total, ${s.running_sample_count} running`,
        `CPU: avg ${s.cpu_percent_avg ?? "n/a"}% / max ${s.cpu_percent_max ?? "n/a"}%`,
        `Memory: max ${s.mem_bytes_max !== null ? formatBytes(s.mem_bytes_max) : "n/a"}`,
        `Network: in ${formatBytes(s.net_rx_bytes_total)} / out ${formatBytes(s.net_tx_bytes_total)}`,
      ];
      const counts = Object.entries(s.event_counts);
      if (counts.length > 0) {
        lines.push(`Events: ${counts.map(([a, n]) => `${a} ${n}`).join(", ")}`);
      }
      const recent = h.events.slice(-8);
      if (recent.length > 0) {
        lines.push("Recent events:");
        for (const e of recent) {
          lines.push(`  ${new Date(e.occurred_at_ms).toISOString()} ${e.action} (${e.source})`);
        }
      }
      if (s.sample_count === 0 && h.events.length === 0) {
        lines.push("(no stored history in this window)");
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );
}
