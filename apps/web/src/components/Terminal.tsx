import { useEffect, useRef } from "react";
import { type XTermHandle, XTermPanel } from "./XTermPanel";

type Props = {
  projectId: number;
  running: boolean;
};

export function Terminal({ projectId, running }: Props) {
  const xtermRef = useRef<XTermHandle>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!running) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/api/projects/${projectId}/terminal`;
    console.log(`[terminal] connecting to ${wsUrl}`);
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      console.log("[terminal] WebSocket connected");
      xtermRef.current?.focus();
    };

    ws.onmessage = (e) => {
      const size = e.data instanceof ArrayBuffer ? e.data.byteLength : e.data.length;
      console.log(`[terminal] received ${size} bytes`);
      if (e.data instanceof ArrayBuffer) {
        xtermRef.current?.write(new Uint8Array(e.data));
      } else {
        xtermRef.current?.write(e.data);
      }
    };

    ws.onclose = (e) => {
      console.log(
        `[terminal] WebSocket closed: code=${e.code} reason=${e.reason} clean=${e.wasClean}`,
      );
      xtermRef.current?.write(
        `\r\n\x1b[90m[Connection closed: ${e.reason || "disconnected"}]\x1b[0m\r\n`,
      );
    };

    ws.onerror = (e) => {
      console.error("[terminal] WebSocket error:", e);
      xtermRef.current?.write("\r\n\x1b[31m[Connection error]\x1b[0m\r\n");
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [projectId, running]);

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

  if (!running) {
    return (
      <div className="log-empty">
        Container is not running. Click <span style={{ color: "var(--green)" }}>Run</span> to start.
      </div>
    );
  }

  return <XTermPanel handle={xtermRef} interactive onData={handleData} onResize={handleResize} />;
}
