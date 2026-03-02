import { useState } from "react";
import { api, type Project } from "../lib/api";
import { CronSection } from "./CronSection";
import { EnvSection } from "./EnvSection";
import { LogsSection } from "./LogsSection";

type Props = {
  project: Project;
  onUpdate: () => void;
  onEdit: () => void;
  onDelete: () => void;
};

export function ProjectDetail({ project, onUpdate, onEdit, onDelete }: Props) {
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const doAction = async (action: "build" | "start" | "stop") => {
    setActionLoading(action);
    try {
      await api.projects[action](project.id);
      await onUpdate();
    } catch (e) {
      alert(`Action failed: ${e}`);
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <div className="detail">
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <h2>{project.name}</h2>
            <button
              type="button"
              className="btn btn-sm"
              onClick={onEdit}
              style={{ marginBottom: 4 }}
            >
              Edit
            </button>
            <button
              type="button"
              className="btn btn-sm btn-danger"
              style={{ marginBottom: 4 }}
              onClick={() => {
                if (confirm(`Delete "${project.name}"? This cannot be undone.`)) onDelete();
              }}
            >
              Delete
            </button>
          </div>
          <div className="meta">
            {project.github_url ? (
              <span>
                {project.github_url} &middot; {project.branch} &middot; {project.dockerfile}
              </span>
            ) : (
              <span>No repository linked</span>
            )}
          </div>
        </div>
        <span className={`badge ${project.status}`}>{project.status}</span>
      </div>

      <div className="section">
        <h3>Actions</h3>
        <div className="btn-group">
          <button
            type="button"
            className="btn"
            disabled={!project.github_url || actionLoading !== null}
            onClick={() => doAction("build")}
          >
            {actionLoading === "build" ? "Building..." : "Build"}
          </button>
          <button
            type="button"
            className="btn"
            disabled={!project.image_tag || project.status === "running" || actionLoading !== null}
            onClick={() => doAction("start")}
          >
            {actionLoading === "start" ? "Starting..." : "Start"}
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={project.status !== "running" || actionLoading !== null}
            onClick={() => doAction("stop")}
          >
            {actionLoading === "stop" ? "Stopping..." : "Stop"}
          </button>
        </div>
      </div>

      <CronSection projectId={project.id} />
      <EnvSection projectId={project.id} />
      <LogsSection projectId={project.id} />
    </div>
  );
}
