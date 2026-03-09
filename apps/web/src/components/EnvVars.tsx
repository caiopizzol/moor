import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";

type Props = { projectId: number };
type Row = { id: string; key: string; value: string };

let nextId = 0;
const makeId = () => `env-${++nextId}`;

export function EnvVars({ projectId }: Props) {
  const [rows, setRows] = useState<Row[]>([]);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [rawMode, setRawMode] = useState(false);
  const [rawText, setRawText] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await api.envs.list(projectId);
      setRows(data.map((e) => ({ id: makeId(), key: e.key, value: e.value })));
      setDirty(false);
    } catch {
      // ignore
    }
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const update = (i: number, field: "key" | "value", val: string) => {
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, [field]: val } : r)));
    setDirty(true);
  };

  const remove = (i: number) => {
    setRows((prev) => prev.filter((_, j) => j !== i));
    setDirty(true);
  };

  const add = () => {
    setRows((prev) => [...prev, { id: makeId(), key: "", value: "" }]);
    setDirty(true);
  };

  const parseEnvText = (text: string): Row[] => {
    return text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const eq = line.indexOf("=");
        if (eq === -1) return null;
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        // Strip surrounding quotes
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        return key ? { id: makeId(), key, value } : null;
      })
      .filter((r): r is Row => r !== null);
  };

  const rowsToRawText = (r: Row[]) => r.map((row) => `${row.key}=${row.value}`).join("\n");

  const enterRawMode = () => {
    setRawText(rows.length > 0 ? rowsToRawText(rows) : "");
    setRawMode(true);
  };

  const exitRawMode = () => {
    setRawMode(false);
  };

  const save = async () => {
    setSaving(true);
    try {
      let toSave: Row[];
      if (rawMode) {
        toSave = parseEnvText(rawText);
      } else {
        toSave = rows.filter((r) => r.key.trim());
      }
      await api.envs.set(
        projectId,
        toSave.map(({ key, value }) => ({ key, value })),
      );
      setRows(toSave);
      setDirty(false);
      setRawMode(false);
    } catch (e) {
      alert(`Failed to save: ${e}`);
    } finally {
      setSaving(false);
    }
  };

  const isDirty = rawMode ? rawText !== rowsToRawText(rows) : dirty;

  return (
    <div>
      {rawMode ? (
        <textarea
          className="mono"
          placeholder={"KEY=value\nDB_HOST=localhost\n# comments are ignored"}
          value={rawText}
          onChange={(e) => setRawText(e.target.value)}
          rows={10}
          spellCheck={false}
          style={{ width: "100%", resize: "vertical" }}
        />
      ) : (
        <div className="env-rows">
          {rows.map((row, i) => (
            <div key={row.id} className="env-row">
              <input
                type="text"
                placeholder="KEY"
                value={row.key}
                onChange={(e) => update(i, "key", e.target.value)}
                spellCheck={false}
              />
              <input
                type="text"
                placeholder="value"
                value={row.value}
                onChange={(e) => update(i, "value", e.target.value)}
                spellCheck={false}
              />
              <button type="button" className="btn btn-sm btn-danger" onClick={() => remove(i)}>
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        {!rawMode && (
          <button type="button" className="btn btn-sm" onClick={add}>
            + Add
          </button>
        )}
        <button type="button" className="btn btn-sm" onClick={rawMode ? exitRawMode : enterRawMode}>
          {rawMode ? "Editor" : "Raw"}
        </button>
        {isDirty && (
          <button type="button" className="btn btn-sm btn-run" disabled={saving} onClick={save}>
            {saving ? "Saving..." : "Save"}
          </button>
        )}
      </div>

      <div style={{ color: "var(--text-muted)", fontSize: "0.8em", marginTop: 8 }}>
        Changes take effect on next Run or Restart.
      </div>
    </div>
  );
}
