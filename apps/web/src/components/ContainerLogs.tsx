import { useCallback, useEffect, useRef } from "react";
import { api } from "../lib/api";
import { type XTermHandle, XTermPanel } from "./XTermPanel";

type Props = {
  projectId: number;
  running: boolean;
};

export function ContainerLogs({ projectId, running }: Props) {
  const xtermRef = useRef<XTermHandle>(null);
  const lastTimestampRef = useRef(0);
  const initializedRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const since = initializedRef.current ? lastTimestampRef.current : undefined;
      const data = await api.projects.logs(projectId, since);
      if (data.logs) {
        if (!initializedRef.current) {
          xtermRef.current?.clear();
          initializedRef.current = true;
        }
        xtermRef.current?.write(data.logs);
      }
      if (data.lastTimestamp) {
        lastTimestampRef.current = data.lastTimestamp;
      }
    } catch {
      // ignore
    }
  }, [projectId]);

  useEffect(() => {
    // Reset state when project changes
    lastTimestampRef.current = 0;
    initializedRef.current = false;
    xtermRef.current?.clear();
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
