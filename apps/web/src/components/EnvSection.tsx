import { useCallback, useEffect, useState } from "react";
import { api, type EnvVar } from "../lib/api";

type Props = { projectId: number };

export function EnvSection({ projectId }: Props) {
  const [envs, setEnvs] = useState<EnvVar[]>([]);
  const [draft, setDraft] = useState<{ key: string; value: string }[]>([]);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    const data = await api.envs.list(projectId);
    setEnvs(data);
    setDraft(data.map((e) => ({ key: e.key, value: e.value })));
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    const valid = draft.filter((d) => d.key.trim());
    await api.envs.set(projectId, valid);
    setEditing(false);
    await load();
  };

  const addRow = () => setDraft([...draft, { key: "", value: "" }]);

  const updateRow = (i: number, field: "key" | "value", val: string) => {
    const next = [...draft];
    next[i] = { ...next[i], [field]: val };
    setDraft(next);
  };

  const removeRow = (i: number) => setDraft(draft.filter((_, j) => j !== i));

  return (
    <div className="section">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 12,
        }}
      >
        <h3 style={{ margin: 0 }}>Environment</h3>
        <div className="btn-group">
          {editing ? (
            <>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  setEditing(false);
                  load();
                }}
              >
                Cancel
              </button>
              <button type="button" className="btn btn-sm btn-primary" onClick={save}>
                Save
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-sm" onClick={() => setEditing(true)}>
              Edit
            </button>
          )}
        </div>
      </div>

      {!editing && envs.length === 0 && (
        <div style={{ color: "var(--text-dim)", fontSize: 13 }}>No environment variables</div>
      )}

      {!editing &&
        envs.map((e) => (
          <div key={e.id} className="kv-row">
            <code style={{ color: "var(--text-muted)", minWidth: 180 }}>{e.key}</code>
            <code style={{ color: "var(--text)" }}>{e.value}</code>
          </div>
        ))}

      {editing && (
        <>
          {draft.map((d, i) => (
            <div key={`env-${d.key || i}`} className="kv-row">
              <input
                className="key-input mono"
                value={d.key}
                onChange={(e) => updateRow(i, "key", e.target.value)}
                placeholder="KEY"
              />
              <input
                className="mono"
                value={d.value}
                onChange={(e) => updateRow(i, "value", e.target.value)}
                placeholder="value"
              />
              <button type="button" className="btn btn-sm btn-danger" onClick={() => removeRow(i)}>
                ×
              </button>
            </div>
          ))}
          <button type="button" className="btn btn-sm" onClick={addRow} style={{ marginTop: 8 }}>
            + Add Variable
          </button>
        </>
      )}
    </div>
  );
}
