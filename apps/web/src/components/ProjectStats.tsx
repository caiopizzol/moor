import { useCallback, useEffect, useRef, useState } from "react";
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
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  // Single-flight: /container-stats can block up to 10s on the Docker daemon,
  // longer than the 4s poll — without this, a slow call would stack multiple
  // in-flight requests from one open tab.
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      setStats(await api.projects.containerStats(projectId));
      setUpdatedAt(Date.now());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load stats");
    } finally {
      inFlight.current = false;
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
        <div className="server-stat-label">Network (total)</div>
        <div className="server-stat-value">{fmtBytes(stats.network_rx_bytes)}</div>
        <div className="server-stat-sub">in &middot; out {fmtBytes(stats.network_tx_bytes)}</div>
      </div>
      <div className="server-stat">
        <div className="server-stat-label">Block I/O (total)</div>
        <div className="server-stat-value">{fmtBytes(stats.block_read_bytes)}</div>
        <div className="server-stat-sub">
          read &middot; write {fmtBytes(stats.block_write_bytes)}
        </div>
      </div>
      <div className="server-stat">
        <div className="server-stat-label">PIDs</div>
        <div className="server-stat-value">{stats.pids}</div>
      </div>
      <div
        style={{
          gridColumn: "1 / -1",
          flexBasis: "100%",
          fontSize: 11,
          color: "#888",
          marginTop: 4,
        }}
      >
        Live snapshot{updatedAt ? ` · updated ${new Date(updatedAt).toLocaleTimeString()}` : ""}{" "}
        &middot; network &amp; block I/O are cumulative since the container started
      </div>
    </div>
  );
}
