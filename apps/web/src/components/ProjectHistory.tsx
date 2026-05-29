import { useCallback, useEffect, useState } from "react";
import { api, type ProjectHistory as HistoryData } from "../lib/api";

// #133: per-project observability history. Reads the stored samples + events
// from /api/projects/:id/stats/history and renders a summary, lightweight
// inline-SVG sparklines (no charting dependency), and a lifecycle-event
// timeline. Not live — this is "what happened", distinct from the build/logs
// tabs. Gaps (container not running, or a recorded event gap) are shown
// honestly rather than as zeros.

const WINDOWS = [
  { label: "1h", hours: 1 },
  { label: "24h", hours: 24 },
  { label: "7d", hours: 168 },
];

function fmtBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes <= 0)
    return bytes === null ? "n/a" : "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const val = bytes / 1024 ** i;
  return `${val.toFixed(val < 10 ? 1 : 0)} ${units[i]}`;
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Inline sparkline. Nulls break the line into separate segments so a gap
// (container down) reads as a gap, not a drop to zero.
function Sparkline({
  values,
  width = 320,
  height = 44,
  color = "#4ade80",
}: {
  values: (number | null)[];
  width?: number;
  height?: number;
  color?: string;
}) {
  const present = values.filter((v): v is number => v !== null);
  if (present.length < 2) {
    return <div style={{ color: "#888", fontSize: 12 }}>not enough data</div>;
  }
  const max = Math.max(...present, 0.0001);
  const n = values.length;
  const dx = n > 1 ? width / (n - 1) : width;
  const segments: string[] = [];
  let current: string[] = [];
  values.forEach((v, i) => {
    if (v === null) {
      if (current.length) segments.push(current.join(" "));
      current = [];
      return;
    }
    const x = (i * dx).toFixed(1);
    const y = (height - (v / max) * height).toFixed(1);
    current.push(`${current.length === 0 ? "M" : "L"}${x},${y}`);
  });
  if (current.length) segments.push(current.join(" "));
  return (
    <svg width={width} height={height} style={{ display: "block" }} aria-hidden="true">
      <title>sparkline</title>
      {segments.map((d) => (
        <path key={d} d={d} fill="none" stroke={color} strokeWidth="1.5" />
      ))}
    </svg>
  );
}

function eventColor(action: string): string {
  if (action.includes("oom")) return "#f87171";
  if (action.includes("error") || action === "die" || action === "kill") return "#fb923c";
  if (action === "docker_event_gap") return "#fbbf24";
  return "#888";
}

export function ProjectHistory({ projectId }: { projectId: number }) {
  const [hours, setHours] = useState(24);
  const [data, setData] = useState<HistoryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const to = Date.now();
      const from = to - hours * 3_600_000;
      setData(await api.projects.history(projectId, from, to));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load history");
    } finally {
      setLoading(false);
    }
  }, [projectId, hours]);

  useEffect(() => {
    load();
  }, [load]);

  const s = data?.summary;
  const events = data ? [...data.events].reverse() : [];

  return (
    <div className="history-panel" style={{ padding: "8px 4px" }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center" }}>
        {WINDOWS.map((w) => (
          <button
            type="button"
            key={w.hours}
            className={`log-tab ${hours === w.hours ? "active" : ""}`}
            onClick={() => setHours(w.hours)}
          >
            {w.label}
          </button>
        ))}
        <button type="button" className="btn btn-ghost btn-sm" onClick={load}>
          Refresh
        </button>
      </div>

      {loading && <div style={{ color: "#888" }}>Loading history…</div>}
      {error && <div style={{ color: "#f87171" }}>{error}</div>}

      {!loading && !error && s && (
        <>
          {s.has_gap && (
            <div style={{ color: "#fbbf24", fontSize: 13, marginBottom: 8 }}>
              ⚠ An event gap was recorded in this window — events may be incomplete.
            </div>
          )}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
              gap: 10,
              marginBottom: 16,
            }}
          >
            <Stat
              label="CPU avg / max"
              value={`${s.cpu_percent_avg ?? "n/a"}% / ${s.cpu_percent_max ?? "n/a"}%`}
            />
            <Stat label="Memory max" value={fmtBytes(s.mem_bytes_max)} />
            <Stat
              label="Net in / out"
              value={`${fmtBytes(s.net_rx_bytes_total)} / ${fmtBytes(s.net_tx_bytes_total)}`}
            />
            <Stat label="Samples" value={`${s.sample_count} (${s.running_sample_count} running)`} />
          </div>

          {data && data.samples.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 24, marginBottom: 16 }}>
              <div>
                <div style={{ fontSize: 12, color: "#888", marginBottom: 4 }}>CPU %</div>
                <Sparkline values={data.samples.map((p) => p.cpu_percent)} color="#4ade80" />
              </div>
              <div>
                <div style={{ fontSize: 12, color: "#888", marginBottom: 4 }}>Memory</div>
                <Sparkline values={data.samples.map((p) => p.mem_bytes)} color="#60a5fa" />
              </div>
            </div>
          )}

          <div style={{ fontSize: 12, color: "#888", marginBottom: 4 }}>
            Events {events.length > 0 ? `(${events.length})` : ""}
          </div>
          {events.length === 0 ? (
            <div style={{ color: "#888" }}>No events in this window.</div>
          ) : (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 2,
                fontFamily: "monospace",
                fontSize: 12,
              }}
            >
              {events.slice(0, 100).map((e) => (
                <div
                  key={`${e.occurred_at_ms}-${e.action}-${e.time_nano ?? ""}`}
                  style={{ display: "flex", gap: 10 }}
                >
                  <span style={{ color: "#888", minWidth: 120 }}>{fmtTime(e.occurred_at_ms)}</span>
                  <span style={{ color: eventColor(e.action), minWidth: 160 }}>{e.action}</span>
                  <span style={{ color: "#666" }}>{e.source}</span>
                </div>
              ))}
            </div>
          )}

          {s.sample_count === 0 && events.length === 0 && (
            <div style={{ color: "#888" }}>No stored history in this window yet.</div>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ border: "1px solid #2a2a2a", borderRadius: 6, padding: "8px 10px" }}>
      <div style={{ fontSize: 11, color: "#888", marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 14 }}>{value}</div>
    </div>
  );
}
