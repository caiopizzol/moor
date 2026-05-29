import { useCallback, useEffect, useState } from "react";
import { api, type ContainerStats } from "../lib/api";

// #138: live per-project resource stats. Polls the single-snapshot
// /container-stats endpoint while the tab is open. This is "right now" —
// distinct from the History tab's retained trends + events. Network/block are
// cumulative-since-container-start totals (same as `docker stats`).

function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const val = bytes / 1024 ** i;
  return `${val.toFixed(val < 10 ? 1 : 0)} ${units[i]}`;
}

export function ProjectStats({ projectId }: { projectId: number }) {
  const [stats, setStats] = useState<ContainerStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStats(await api.projects.containerStats(projectId));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load stats");
    }
  }, [projectId]);

  useEffect(() => {
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [load]);

  if (error) return <div style={{ color: "#f87171", padding: "8px 4px" }}>{error}</div>;
  if (!stats) return <div style={{ color: "#888", padding: "8px 4px" }}>Loading live stats…</div>;
  if (!stats.running) {
    return (
      <div style={{ color: "#888", padding: "8px 4px" }}>
        Container is not running — no live stats.
      </div>
    );
  }

  const memLimit = stats.memory_limit_bytes > 0 ? fmtBytes(stats.memory_limit_bytes) : "unlimited";

  return (
    <div className="server-stats" style={{ paddingTop: 8 }}>
      <div className="server-stat">
        <div className="server-stat-label">CPU</div>
        <div className="server-stat-value">{stats.cpu_percent}%</div>
        <div className="server-stat-bar">
          <div
            className="server-stat-fill"
            style={{ width: `${Math.min(100, stats.cpu_percent)}%` }}
          />
        </div>
      </div>
      <div className="server-stat">
        <div className="server-stat-label">Memory</div>
        <div className="server-stat-value">{fmtBytes(stats.memory_bytes)}</div>
        <div className="server-stat-sub">
          of {memLimit} &middot; {stats.memory_percent}%
        </div>
        <div className="server-stat-bar">
          <div
            className="server-stat-fill"
            style={{ width: `${Math.min(100, stats.memory_percent)}%` }}
          />
        </div>
      </div>
      <div className="server-stat">
        <div className="server-stat-label">Network</div>
        <div className="server-stat-value">{fmtBytes(stats.network_rx_bytes)}</div>
        <div className="server-stat-sub">in &middot; out {fmtBytes(stats.network_tx_bytes)}</div>
      </div>
      <div className="server-stat">
        <div className="server-stat-label">Block I/O</div>
        <div className="server-stat-value">{fmtBytes(stats.block_read_bytes)}</div>
        <div className="server-stat-sub">
          read &middot; write {fmtBytes(stats.block_write_bytes)}
        </div>
      </div>
      <div className="server-stat">
        <div className="server-stat-label">PIDs</div>
        <div className="server-stat-value">{stats.pids}</div>
      </div>
    </div>
  );
}
