import { useCallback, useEffect, useState } from "react";
import { api, type Run } from "../lib/api";

type Props = { projectId: number };

export function LogsSection({ projectId }: Props) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [detail, setDetail] = useState<Run | null>(null);

  const load = useCallback(async () => {
    const data = await api.runs.list(projectId, page);
    setRuns(data.runs);
    setTotal(data.total);
  }, [projectId, page]);

  useEffect(() => {
    load();
  }, [load]);

  const toggleExpand = async (id: number) => {
    if (expanded === id) {
      setExpanded(null);
      setDetail(null);
      return;
    }
    setExpanded(id);
    setDetail(await api.runs.get(id));
  };

  const totalPages = Math.ceil(total / 20);

  return (
    <div className="section">
      <h3>Run History</h3>
      {runs.length === 0 && (
        <div style={{ color: "var(--text-dim)", fontSize: 13 }}>No runs yet</div>
      )}
      {runs.map((r) => (
        <div key={r.id}>
          <button type="button" className="run-row" onClick={() => toggleExpand(r.id)}>
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background:
                  r.exit_code === 0
                    ? "var(--green)"
                    : r.exit_code != null
                      ? "var(--red)"
                      : "var(--yellow)",
                flexShrink: 0,
              }}
            />
            <span style={{ flex: 1, fontSize: 13 }}>{r.cron_name || `Run #${r.id}`}</span>
            <span className="mono" style={{ color: "var(--text-muted)", fontSize: 12 }}>
              {r.duration_ms != null ? `${r.duration_ms}ms` : "running"}
            </span>
            <span style={{ color: "var(--text-dim)", fontSize: 12 }}>
              {new Date(r.started_at).toLocaleString()}
            </span>
          </button>
          {expanded === r.id && detail && (
            <div className="log-output" style={{ margin: "8px 0 12px" }}>
              {detail.stdout || ""}
              {detail.stderr ? `\n--- stderr ---\n${detail.stderr}` : ""}
              {!detail.stdout && !detail.stderr && "(no output)"}
            </div>
          )}
        </div>
      ))}
      {totalPages > 1 && (
        <div style={{ display: "flex", gap: 8, marginTop: 12, justifyContent: "center" }}>
          <button
            type="button"
            className="btn btn-sm"
            disabled={page <= 1}
            onClick={() => setPage(page - 1)}
          >
            Prev
          </button>
          <span style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: "28px" }}>
            {page} / {totalPages}
          </span>
          <button
            type="button"
            className="btn btn-sm"
            disabled={page >= totalPages}
            onClick={() => setPage(page + 1)}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
