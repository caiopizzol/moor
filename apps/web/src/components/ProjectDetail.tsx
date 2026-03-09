import { useState } from "react";
import { api, type Project } from "../lib/api";
import { BuildOutput } from "./BuildOutput";
import { ContainerLogs } from "./ContainerLogs";
import { Terminal } from "./Terminal";

type Props = {
  project: Project;
  onUpdate: () => void;
  onEdit: () => void;
  onDelete: () => void;
};

type Tab = "build" | "logs" | "terminal";

export function ProjectDetail({ project, onUpdate, onEdit, onDelete }: Props) {
  const [actionLoading, setActionLoading] = useState(false);
  const [tab, setTab] = useState<Tab>("build");

  const isRunning = project.status === "running";
  const isBuilding = project.status === "building";

  const handleRun = async () => {
    setActionLoading(true);
    setTab("build");
    try {
      await api.projects.run(project.id);
      await onUpdate();
    } catch (e) {
      alert(`Run failed: ${e}`);
      await onUpdate();
    } finally {
      setActionLoading(false);
    }
  };

  const handleStop = async () => {
    setActionLoading(true);
    try {
      await api.projects.stop(project.id);
      await onUpdate();
    } catch (e) {
      alert(`Stop failed: ${e}`);
    } finally {
      setActionLoading(false);
    }
  };

  return (
    <div className="detail">
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <h2>{project.name}</h2>
            <div className="btn-group">
              {isRunning ? (
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={actionLoading}
                  onClick={handleStop}
                >
                  {actionLoading ? "Stopping..." : "Stop"}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-run"
                  disabled={actionLoading || isBuilding || !project.github_url}
                  onClick={handleRun}
                >
                  {actionLoading || isBuilding ? "Running..." : "Run"}
                </button>
              )}
              <button type="button" className="btn btn-sm" onClick={onEdit}>
                Edit
              </button>
              <button
                type="button"
                className="btn btn-sm btn-danger"
                onClick={() => {
                  if (confirm(`Delete "${project.name}"? This cannot be undone.`)) onDelete();
                }}
              >
                Delete
              </button>
            </div>
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
        <div className="log-tabs">
          <button
            type="button"
            className={`log-tab ${tab === "build" ? "active" : ""}`}
            onClick={() => setTab("build")}
          >
            Build Output
          </button>
          <button
            type="button"
            className={`log-tab ${tab === "logs" ? "active" : ""}`}
            onClick={() => setTab("logs")}
          >
            Container Logs
          </button>
          <button
            type="button"
            className={`log-tab ${tab === "terminal" ? "active" : ""}`}
            onClick={() => setTab("terminal")}
          >
            Terminal
          </button>
        </div>

        {tab === "build" && <BuildOutput projectId={project.id} />}
        {tab === "logs" && <ContainerLogs projectId={project.id} running={isRunning} />}
        {tab === "terminal" && <Terminal projectId={project.id} running={isRunning} />}
      </div>
    </div>
  );
}
