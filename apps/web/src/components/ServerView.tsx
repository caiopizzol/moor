import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { type XTermHandle, XTermPanel } from "./XTermPanel";

type Stats = {
  hostname: string;
  os: string;
  uptime: string;
  cpu: { percent: number; cores: number };
  memory: { total: string; used: string; percent: number };
  disk: { total: string; used: string; percent: number };
  // #137: every real filesystem, not just root. Falls back to [disk] if a
  // pre-#137 API doesn't send it.
  disks?: { mount: string; total: string; used: string; percent: number; label?: string }[];
  containers: { running: number; total: number };
};

export function ServerView() {
  const [stats, setStats] = useState<Stats | null>(null);
  const xtermRef = useRef<XTermHandle>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const loadStats = useCallback(async () => {
    try {
      const data = await api.server.stats();
      setStats(data);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    loadStats();
    const interval = setInterval(loadStats, 10000);
    return () => clearInterval(interval);
  }, [loadStats]);

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/api/terminal`);
    wsRef.current = ws;
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      xtermRef.current?.focus();
    };

    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        xtermRef.current?.write(new Uint8Array(e.data));
      } else {
        xtermRef.current?.write(e.data);
      }
    };

    ws.onclose = (e) => {
      xtermRef.current?.write(
        `\r\n\x1b[90m[Connection closed: ${e.reason || "disconnected"}]\x1b[0m\r\n`,
      );
    };

    ws.onerror = () => {
      xtermRef.current?.write("\r\n\x1b[31m[Connection error]\x1b[0m\r\n");
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, []);

  const handleData = (data: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(data);
    }
  };

  const handleResize = (cols: number, rows: number) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "resize", cols, rows }));
    }
  };

  return (
    <div className="detail">
      <div className="server-header">
        <h2 className="server-title">Server</h2>
        {stats ? (
          <div className="server-meta">
            {stats.hostname} &middot; {stats.os} &middot; up {stats.uptime}
          </div>
        ) : (
          <div className="skeleton" style={{ width: 260, height: 14, marginTop: 4 }} />
        )}
      </div>

      {stats ? (
        <div className="server-stats">
          <div className="server-stat">
            <div className="server-stat-label">CPU</div>
            <div className="server-stat-value">{stats.cpu.percent}%</div>
            <div className="server-stat-sub">{stats.cpu.cores} cores</div>
            <div className="server-stat-bar">
              <div className="server-stat-fill" style={{ width: `${stats.cpu.percent}%` }} />
            </div>
          </div>
          <div className="server-stat">
            <div className="server-stat-label">Memory</div>
            <div className="server-stat-value">{stats.memory.used}</div>
            <div className="server-stat-sub">of {stats.memory.total}</div>
            <div className="server-stat-bar">
              <div className="server-stat-fill" style={{ width: `${stats.memory.percent}%` }} />
            </div>
          </div>
          {(stats.disks?.length ? stats.disks : [{ mount: "/", ...stats.disk }]).map((d) => (
            <div className="server-stat" key={d.mount}>
              <div className="server-stat-label">{d.label ?? `Disk ${d.mount}`}</div>
              <div className="server-stat-value">{d.used}</div>
              <div className="server-stat-sub">
                {d.label ? `${d.mount} · ` : ""}of {d.total} &middot; {d.percent}%
              </div>
              <div className="server-stat-bar">
                <div className="server-stat-fill" style={{ width: `${d.percent}%` }} />
              </div>
            </div>
          ))}
          <div className="server-stat">
            <div className="server-stat-label">Containers</div>
            <div className="server-stat-value">
              {stats.containers.running} / {stats.containers.total}
            </div>
            <div className="server-stat-sub">running</div>
          </div>
        </div>
      ) : (
        <div className="server-stats">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="server-stat">
              <div className="skeleton" style={{ width: 32, height: 10, marginBottom: 8 }} />
              <div className="skeleton" style={{ width: 48, height: 20, marginBottom: 6 }} />
              <div className="skeleton" style={{ width: 56, height: 10, marginBottom: 10 }} />
              <div className="skeleton" style={{ width: "100%", height: 3 }} />
            </div>
          ))}
        </div>
      )}

      <div className="server-terminal-section">
        <XTermPanel handle={xtermRef} interactive onData={handleData} onResize={handleResize} />
      </div>
    </div>
  );
}
