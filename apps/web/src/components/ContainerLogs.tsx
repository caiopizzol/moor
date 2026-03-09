import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";

type Props = {
  projectId: number;
  running: boolean;
};

export function ContainerLogs({ projectId, running }: Props) {
  const [logs, setLogs] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.projects.logs(projectId);
      setLogs(data.logs);
    } catch {
      setLogs("");
    }
  }, [projectId]);

  useEffect(() => {
    load();

    if (!running) return;

    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, [load, running]);

  // Auto-scroll to bottom on new logs
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when logs change
  useEffect(() => {
    if (boxRef.current) {
      boxRef.current.scrollTop = boxRef.current.scrollHeight;
    }
  }, [logs]);

  if (!running && !logs) {
    return <div className="log-empty">Container is not running.</div>;
  }

  return (
    <div className="log-output" ref={boxRef}>
      {logs || "No output yet."}
    </div>
  );
}
