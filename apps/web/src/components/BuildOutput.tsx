import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Run } from "../lib/api";
import { type XTermHandle, XTermPanel } from "./XTermPanel";

type Props = {
  projectId: number;
  streamingLines?: string[];
  isImageProject?: boolean;
};

export function BuildOutput({ projectId, streamingLines, isImageProject }: Props) {
  const [run, setRun] = useState<Run | null>(null);
  const [loading, setLoading] = useState(true);
  const xtermRef = useRef<XTermHandle>(null);
  const writtenRef = useRef(0);

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

  // Write streaming lines incrementally
  useEffect(() => {
    if (!streamingLines || !xtermRef.current) return;
    // Reset if new stream
    if (streamingLines.length === 0) {
      writtenRef.current = 0;
      xtermRef.current.clear();
      return;
    }
    for (let i = writtenRef.current; i < streamingLines.length; i++) {
      xtermRef.current.write(streamingLines[i]);
    }
    writtenRef.current = streamingLines.length;
  }, [streamingLines]);

  // Write saved build output when loaded
  useEffect(() => {
    if (run?.stdout && xtermRef.current && !streamingLines) {
      xtermRef.current.write(run.stdout);
    }
  }, [run, streamingLines]);

  // Streaming mode
  if (streamingLines !== undefined) {
    return <XTermPanel handle={xtermRef} />;
  }

  if (loading) return null;

  if (!run?.stdout) {
    return (
      <div className="log-empty">
        {isImageProject ? (
          <>
            No pulls yet. Click <span style={{ color: "var(--green)" }}>Run</span> to pull and
            start.
          </>
        ) : (
          <>
            No builds yet. Click <span style={{ color: "var(--green)" }}>Run</span> to build and
            start.
          </>
        )}
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
          Last {isImageProject ? "pull" : "build"}: {timestamp} — exit code {run.exit_code ?? "?"}
        </div>
      )}
      <XTermPanel handle={xtermRef} />
    </div>
  );
}
