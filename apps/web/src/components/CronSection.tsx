import { useCallback, useEffect, useState } from "react";
import { api, type Cron } from "../lib/api";

type Props = { projectId: number };

export function CronSection({ projectId }: Props) {
  const [crons, setCrons] = useState<Cron[]>([]);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: "", schedule: "", command: "" });

  const load = useCallback(async () => {
    setCrons(await api.crons.list(projectId));
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name || !form.schedule || !form.command) return;
    await api.crons.create(projectId, form);
    setForm({ name: "", schedule: "", command: "" });
    setAdding(false);
    await load();
  };

  const toggle = async (cron: Cron) => {
    await api.crons.update(cron.id, { enabled: cron.enabled ? 0 : 1 });
    await load();
  };

  const remove = async (id: number) => {
    await api.crons.delete(id);
    await load();
  };

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
        <h3 style={{ margin: 0 }}>Schedule</h3>
        <button type="button" className="btn btn-sm" onClick={() => setAdding(!adding)}>
          {adding ? "Cancel" : "+ Add"}
        </button>
      </div>

      {adding && (
        <form
          onSubmit={handleAdd}
          style={{ marginBottom: 16, display: "flex", flexDirection: "column", gap: 8 }}
        >
          <input
            placeholder="Name (e.g. nightly-backup)"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <input
            placeholder="Schedule (e.g. 0 2 * * *)"
            value={form.schedule}
            onChange={(e) => setForm({ ...form, schedule: e.target.value })}
            className="mono"
          />
          <input
            placeholder="Command (e.g. /app/backup.sh)"
            value={form.command}
            onChange={(e) => setForm({ ...form, command: e.target.value })}
            className="mono"
          />
          <button
            type="submit"
            className="btn btn-primary btn-sm"
            style={{ alignSelf: "flex-start" }}
          >
            Save
          </button>
        </form>
      )}

      {crons.length === 0 && !adding && (
        <div style={{ color: "var(--text-dim)", fontSize: 13 }}>No scheduled jobs</div>
      )}

      {crons.map((c) => (
        <div
          key={c.id}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "8px 0",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <button
            type="button"
            className={`toggle ${c.enabled ? "on" : ""}`}
            onClick={() => toggle(c)}
          />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 500 }}>{c.name}</div>
            <div className="mono" style={{ color: "var(--text-muted)", fontSize: 12 }}>
              {c.schedule} &middot; {c.command}
            </div>
          </div>
          <button type="button" className="btn btn-sm btn-danger" onClick={() => remove(c.id)}>
            Remove
          </button>
        </div>
      ))}
    </div>
  );
}
