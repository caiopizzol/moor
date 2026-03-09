import { useCallback, useEffect, useState } from "react";
import { api, type Run } from "../lib/api";

type Props = {
  projectId: number;
};

export function BuildOutput({ projectId }: Props) {
  const [output, setOutput] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const data = await api.projects.buildOutput(projectId);
      if ("output" in data && data.output === null) {
        setOutput(null);
      } else {
        setOutput((data as Run).stdout || null);
      }
    } catch {
      setOutput(null);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return null;

  if (!output) {
    return (
      <div className="log-empty">
        No builds yet. Click <span style={{ color: "var(--green)" }}>Run</span> to build and start.
      </div>
    );
  }

  return <div className="log-output">{output}</div>;
}
