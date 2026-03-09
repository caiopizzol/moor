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
  const [streamingLines, setStreamingLines] = useState<string[] | undefined>(undefined);

  const isRunning = project.status === "running";
  const isBuilding = project.status === "building";

  const startStreamingRun = async () => {
    setActionLoading(true);
    setTab("build");
    setStreamingLines([]);
    try {
      await api.projects.runStream(
        project.id,
        (line) => setStreamingLines((prev) => [...(prev || []), line]),
        () => {
          setStreamingLines(undefined);
          onUpdate();
          setActionLoading(false);
        },
        (err) => {
          setStreamingLines((prev) => [...(prev || []), `\nError: ${err}\n`]);
          onUpdate();
          setActionLoading(false);
        },
      );
    } catch (e) {
      setStreamingLines((prev) => [...(prev || []), `\nError: ${e}\n`]);
      onUpdate();
      setActionLoading(false);
    }
  };

  const handleRun = () => startStreamingRun();

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

  const handleRestart = async () => {
    setActionLoading(true);
    try {
      await api.projects.stop(project.id);
      await api.projects.start(project.id);
      await onUpdate();
    } catch (e) {
      alert(`Restart failed: ${e}`);
      await onUpdate();
    } finally {
      setActionLoading(false);
    }
  };

  const handleRebuild = async () => {
    if (isRunning) {
      setActionLoading(true);
      try {
        await api.projects.stop(project.id);
        await onUpdate();
      } catch (e) {
        alert(`Stop failed: ${e}`);
        setActionLoading(false);
        return;
      }
      setActionLoading(false);
    }
    startStreamingRun();
  };

  return (
    <div className="detail">
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <h2>{project.name}</h2>
            <div className="btn-group">
              {isRunning ? (
                <>
                  <button
                    type="button"
                    className="btn btn-danger"
                    disabled={actionLoading}
                    onClick={handleStop}
                  >
                    Stop
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={actionLoading}
                    onClick={handleRestart}
                  >
                    Restart
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={actionLoading}
                    onClick={handleRebuild}
                  >
                    Rebuild
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="btn btn-run"
                    disabled={actionLoading || isBuilding || !project.github_url}
                    onClick={handleRun}
                  >
                    {isBuilding ? "Building..." : "Run"}
                  </button>
                  {project.image_tag && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={actionLoading || isBuilding}
                      onClick={handleRebuild}
                    >
                      Rebuild
                    </button>
                  )}
                </>
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

        {tab === "build" && <BuildOutput projectId={project.id} streamingLines={streamingLines} />}
        {tab === "logs" && <ContainerLogs projectId={project.id} running={isRunning} />}
        {tab === "terminal" && <Terminal projectId={project.id} running={isRunning} />}
      </div>
    </div>
  );
}
