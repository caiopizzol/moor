import { useCallback, useEffect, useRef } from "react";
import { api } from "../lib/api";
import { type XTermHandle, XTermPanel } from "./XTermPanel";

type Props = {
  projectId: number;
  running: boolean;
};

export function ContainerLogs({ projectId, running }: Props) {
  const xtermRef = useRef<XTermHandle>(null);
  const prevLogsRef = useRef("");

  const load = useCallback(async () => {
    try {
      const data = await api.projects.logs(projectId);
      if (data.logs && data.logs !== prevLogsRef.current) {
        prevLogsRef.current = data.logs;
        xtermRef.current?.clear();
        xtermRef.current?.write(data.logs);
      }
    } catch {
      // ignore
    }
  }, [projectId]);

  useEffect(() => {
    load();
    if (!running) return;
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, [load, running]);

  if (!running) {
    return (
      <div className="log-empty">
        Container is not running. Click <span style={{ color: "var(--green)" }}>Run</span> to start.
      </div>
    );
  }

  return <XTermPanel handle={xtermRef} />;
}
