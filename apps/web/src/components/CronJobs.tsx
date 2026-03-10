import { useCallback, useEffect, useState } from "react";
import { api, type Cron, type Run } from "../lib/api";

type Props = { projectId: number };

function describeCron(schedule: string): string | null {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, mon, dow] = parts;

  if (min === "*" && hour === "*" && dom === "*" && mon === "*" && dow === "*")
    return "Every minute";

  const minStep = min.match(/^\*\/(\d+)$/);
  if (minStep && hour === "*" && dom === "*" && mon === "*" && dow === "*")
    return `Every ${minStep[1]} minutes`;

  if (min === "0" && hour.match(/^\*\/(\d+)$/) && dom === "*" && mon === "*" && dow === "*") {
    const h = hour.match(/^\*\/(\d+)$/)![1];
    return `Every ${h} hours`;
  }

  if (min.match(/^\d+$/) && hour === "*" && dom === "*" && mon === "*" && dow === "*")
    return `Every hour at :${min.padStart(2, "0")}`;

  if (min.match(/^\d+$/) && hour.match(/^\d+$/) && dom === "*" && mon === "*" && dow === "*")
    return `Daily at ${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;

  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  if (
    min.match(/^\d+$/) &&
    hour.match(/^\d+$/) &&
    dom === "*" &&
    mon === "*" &&
    dow.match(/^[\d,]+$/)
  ) {
    const days = dow.split(",").map((d) => dayNames[Number(d)] || d);
    return `${days.join(", ")} at ${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
  }

  if (min.match(/^\d+$/) && hour.match(/^\d+$/) && dom.match(/^\d+$/) && mon === "*" && dow === "*")
    return `Monthly on day ${dom} at ${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;

  return null;
}

function isValidCron(schedule: string): boolean {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const fieldPattern = /^(\*|(\d+(-\d+)?(\/\d+)?)(,(\d+(-\d+)?(\/\d+)?))*|\*\/\d+)$/;
  return parts.every((p) => fieldPattern.test(p));
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// --- Schedule Builder ---

type Frequency = "minutes" | "hourly" | "daily" | "weekly" | "monthly";

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function ScheduleBuilder({ onApply }: { onApply: (expr: string) => void }) {
  const [freq, setFreq] = useState<Frequency>("daily");
  const [every, setEvery] = useState(5);
  const [hour, setHour] = useState(0);
  const [minute, setMinute] = useState(0);
  const [days, setDays] = useState<number[]>([1]); // Monday
  const [dom, setDom] = useState(1);

  const toggleDay = (d: number) =>
    setDays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort()));

  const buildExpr = (): string => {
    switch (freq) {
      case "minutes":
        return `*/${every} * * * *`;
      case "hourly":
        return `${minute} * * * *`;
      case "daily":
        return `${minute} ${hour} * * *`;
      case "weekly":
        return `${minute} ${hour} * * ${days.join(",")}`;
      case "monthly":
        return `${minute} ${hour} ${dom} * *`;
    }
  };

  const expr = buildExpr();

  return (
    <div className="cron-builder">
      <div className="cron-builder-row">
        <select
          className="cron-builder-select"
          value={freq}
          onChange={(e) => setFreq(e.target.value as Frequency)}
        >
          <option value="minutes">Every N minutes</option>
          <option value="hourly">Hourly</option>
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
          <option value="monthly">Monthly</option>
        </select>

        {freq === "minutes" && (
          <span className="cron-builder-inline">
            every
            <input
              type="number"
              min={1}
              max={59}
              value={every}
              onChange={(e) => setEvery(Number(e.target.value) || 1)}
              className="cron-builder-num"
            />
            min
          </span>
        )}

        {freq === "hourly" && (
          <span className="cron-builder-inline">
            at :
            <input
              type="number"
              min={0}
              max={59}
              value={minute}
              onChange={(e) => setMinute(Number(e.target.value) || 0)}
              className="cron-builder-num"
            />
          </span>
        )}

        {(freq === "daily" || freq === "weekly" || freq === "monthly") && (
          <span className="cron-builder-inline">
            at
            <input
              type="number"
              min={0}
              max={23}
              value={hour}
              onChange={(e) => setHour(Number(e.target.value) || 0)}
              className="cron-builder-num"
            />
            :
            <input
              type="number"
              min={0}
              max={59}
              value={minute}
              onChange={(e) => setMinute(Number(e.target.value) || 0)}
              className="cron-builder-num"
            />
          </span>
        )}

        {freq === "monthly" && (
          <span className="cron-builder-inline">
            on day
            <input
              type="number"
              min={1}
              max={31}
              value={dom}
              onChange={(e) => setDom(Number(e.target.value) || 1)}
              className="cron-builder-num"
            />
          </span>
        )}
      </div>

      {freq === "weekly" && (
        <div className="cron-builder-days">
          {DAY_LABELS.map((label, i) => (
            <button
              type="button"
              key={label}
              className={`cron-builder-day ${days.includes(i) ? "active" : ""}`}
              onClick={() => toggleDay(i)}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      <div className="cron-builder-footer">
        <code className="cron-builder-expr">{expr}</code>
        <button type="button" className="btn btn-sm btn-run" onClick={() => onApply(expr)}>
          Apply
        </button>
      </div>
    </div>
  );
}

// --- Main Component ---

type CronWithLastRun = Cron & { lastRun?: Run };

export function CronJobs({ projectId }: Props) {
  const [crons, setCrons] = useState<CronWithLastRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Partial<Cron> | null>(null);
  const [saving, setSaving] = useState(false);
  const [showBuilder, setShowBuilder] = useState(false);

  const load = useCallback(async () => {
    try {
      const cronList = await api.crons.list(projectId);
      const { runs } = await api.runs.list(projectId);
      const withLastRun: CronWithLastRun[] = cronList.map((c) => ({
        ...c,
        lastRun: runs.find((r) => r.cron_id === c.id),
      }));
      setCrons(withLastRun);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleSave = async () => {
    if (!editing?.name?.trim() || !editing?.schedule?.trim() || !editing?.command?.trim()) return;
    if (!isValidCron(editing.schedule!)) return;
    setSaving(true);
    try {
      if (editing.id) {
        await api.crons.update(editing.id, {
          name: editing.name,
          schedule: editing.schedule,
          command: editing.command,
        });
      } else {
        await api.crons.create(projectId, {
          name: editing.name,
          schedule: editing.schedule,
          command: editing.command,
        });
      }
      setEditing(null);
      setShowBuilder(false);
      await load();
    } catch (e) {
      alert(`Failed to save: ${e}`);
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (cron: Cron) => {
    try {
      await api.crons.update(cron.id, { enabled: cron.enabled ? 0 : 1 });
      await load();
    } catch (e) {
      alert(`Failed to update: ${e}`);
    }
  };

  const handleDelete = async (cron: Cron) => {
    if (!confirm(`Delete cron "${cron.name}"?`)) return;
    try {
      await api.crons.delete(cron.id);
      await load();
    } catch (e) {
      alert(`Failed to delete: ${e}`);
    }
  };

  // Only auto-open form on initial load when empty
  const [initialLoad, setInitialLoad] = useState(true);
  useEffect(() => {
    if (!loading && initialLoad) {
      setInitialLoad(false);
      if (crons.length === 0) {
        setEditing({ name: "", schedule: "", command: "" });
      }
    }
  }, [loading, initialLoad, crons.length]);

  if (loading) return null;

  const schedule = editing?.schedule?.trim() || "";
  const valid = schedule ? isValidCron(schedule) : false;
  const description = schedule ? describeCron(schedule) : null;

  if (editing) {
    return (
      <div>
        <div className="cron-form-row">
          <input
            type="text"
            placeholder="name"
            value={editing.name || ""}
            onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            spellCheck={false}
            className="cron-input-name"
          />
          <input
            type="text"
            placeholder="command"
            value={editing.command || ""}
            onChange={(e) => setEditing({ ...editing, command: e.target.value })}
            spellCheck={false}
            className="cron-input-command"
          />
          <input
            type="text"
            placeholder="* * * * *"
            value={editing.schedule || ""}
            onChange={(e) => {
              setEditing({ ...editing, schedule: e.target.value });
              setShowBuilder(false);
            }}
            spellCheck={false}
            className={`cron-input-schedule ${schedule && !valid ? "invalid" : ""}`}
          />
          {schedule && <span className={`cron-dot ${valid ? "valid" : "invalid"}`} />}
          <button
            type="button"
            className={`btn btn-sm cron-builder-toggle ${showBuilder ? "active" : ""}`}
            onClick={() => setShowBuilder(!showBuilder)}
            title="Schedule builder"
          >
            Builder
          </button>
        </div>
        {schedule && !valid ? (
          <div className="cron-hint invalid">Expected 5 fields: minute hour day month weekday</div>
        ) : valid && description ? (
          <div className="cron-hint">{description}</div>
        ) : null}

        {showBuilder && (
          <ScheduleBuilder
            onApply={(expr) => {
              setEditing({ ...editing, schedule: expr });
              setShowBuilder(false);
            }}
          />
        )}

        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <button
            type="button"
            className="btn btn-sm btn-run"
            disabled={saving || !editing.name?.trim() || !valid || !editing.command?.trim()}
            onClick={handleSave}
          >
            {saving ? "Saving..." : editing.id ? "Update" : "Create"}
          </button>
          {crons.length > 0 && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setEditing(null);
                setShowBuilder(false);
              }}
            >
              Cancel
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div>
      {crons.length === 0 ? (
        <div className="log-empty">No scheduled jobs yet.</div>
      ) : (
        <div className="cron-rows">
          {crons.map((cron) => (
            <div key={cron.id} className="cron-row">
              <button
                type="button"
                className={`cron-toggle ${cron.enabled ? "on" : ""}`}
                onClick={() => handleToggle(cron)}
                title={cron.enabled ? "Disable" : "Enable"}
              >
                <span className="cron-toggle-knob" />
              </button>
              <span className={`cron-row-name ${!cron.enabled ? "disabled" : ""}`}>
                {cron.name}
              </span>
              <span className="cron-row-command">{cron.command}</span>
              <span className="cron-row-schedule">
                {describeCron(cron.schedule) || cron.schedule}
              </span>
              <button type="button" className="btn btn-sm" onClick={() => setEditing(cron)}>
                Edit
              </button>
              <button
                type="button"
                className="btn btn-sm btn-danger"
                onClick={() => handleDelete(cron)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => setEditing({ name: "", schedule: "", command: "" })}
        >
          + Add
        </button>
      </div>
    </div>
  );
}
