import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Run } from "../lib/api";

type Props = {
  projectId: number;
  streamingLines?: string[];
};

export function BuildOutput({ projectId, streamingLines }: Props) {
  const [run, setRun] = useState<Run | null>(null);
  const [loading, setLoading] = useState(true);
  const logRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.projects.buildOutput(projectId);
      if ("output" in data && data.output === null) {
        setRun(null);
      } else {
        setRun(data as Run);
      }
    } catch {
      setRun(null);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (!streamingLines) load();
  }, [load, streamingLines]);

  // Auto-scroll during streaming
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when streaming lines change
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [streamingLines]);

  // Streaming mode
  if (streamingLines !== undefined) {
    if (streamingLines.length === 0) {
      return <div className="log-empty">Building...</div>;
    }
    return (
      <div className="log-output" ref={logRef}>
        {streamingLines.join("")}
      </div>
    );
  }

  if (loading) return null;

  if (!run?.stdout) {
    return (
      <div className="log-empty">
        No builds yet. Click <span style={{ color: "var(--green)" }}>Run</span> to build and start.
      </div>
    );
  }

  const timestamp = run.finished_at
    ? new Date(run.finished_at).toLocaleString()
    : run.started_at
      ? new Date(run.started_at).toLocaleString()
      : null;

  return (
    <div>
      {timestamp && (
        <div style={{ color: "var(--text-muted)", fontSize: "0.85em", marginBottom: 8 }}>
          Last build: {timestamp} — exit code {run.exit_code ?? "?"}
        </div>
      )}
      <div className="log-output">{run.stdout}</div>
    </div>
  );
}
