import { useState } from "react";
import { api, type Project } from "../lib/api";
import { BuildOutput } from "./BuildOutput";
import { ContainerLogs } from "./ContainerLogs";
import { EnvVars } from "./EnvVars";
import { Terminal } from "./Terminal";

type Props = {
  project: Project;
  onUpdate: () => void;
  onEdit: () => void;
  onDelete: () => void;
};

type Tab = "build" | "logs" | "terminal" | "env";
type Action = null | "stopping" | "restarting" | "rebuilding" | "building";

export function ProjectDetail({ project, onUpdate, onEdit, onDelete }: Props) {
  const [action, setAction] = useState<Action>(null);
  const [tab, setTab] = useState<Tab>("build");
  const [streamingLines, setStreamingLines] = useState<string[] | undefined>(undefined);

  const isRunning = project.status === "running";
  const isBuilding = project.status === "building";
  const actionLoading = action !== null;

  // Display status: action overrides project.status
  const displayStatus = action || project.status;

  const startStreamingRun = async (noCache = false) => {
    setAction("building");
    setTab("build");
    setStreamingLines([]);
    try {
      await api.projects.runStream(
        project.id,
        (line) => setStreamingLines((prev) => [...(prev || []), line]),
        () => {
          setStreamingLines(undefined);
          onUpdate();
          setAction(null);
        },
        (err) => {
          setStreamingLines((prev) => [...(prev || []), `\nError: ${err}\n`]);
          onUpdate();
          setAction(null);
        },
        noCache,
      );
    } catch (e) {
      setStreamingLines((prev) => [...(prev || []), `\nError: ${e}\n`]);
      onUpdate();
      setAction(null);
    }
  };

  const handleRun = () => startStreamingRun();

  const handleStop = async () => {
    setAction("stopping");
    try {
      await api.projects.stop(project.id);
      await onUpdate();
    } catch (e) {
      alert(`Stop failed: ${e}`);
    } finally {
      setAction(null);
    }
  };

  const handleRestart = async () => {
    setAction("restarting");
    setTab("build");
    setStreamingLines(["Stopping container...\n"]);
    try {
      await api.projects.stop(project.id);
      setStreamingLines((prev) => [
        ...(prev || []),
        "Container stopped.\n\nStarting container...\n",
      ]);
      await api.projects.start(project.id);
      setStreamingLines((prev) => [...(prev || []), "Container started.\n"]);
      await onUpdate();
    } catch (e) {
      setStreamingLines((prev) => [...(prev || []), `\nError: ${e}\n`]);
      await onUpdate();
    } finally {
      setAction(null);
      setStreamingLines(undefined);
    }
  };

  const handleRebuild = async () => {
    setAction("rebuilding");
    setTab("build");
    setStreamingLines([]);
    if (isRunning) {
      setStreamingLines(["Stopping container...\n"]);
      try {
        await api.projects.stop(project.id);
        setStreamingLines((prev) => [...(prev || []), "Container stopped.\n\n"]);
        await onUpdate();
      } catch (e) {
        alert(`Stop failed: ${e}`);
        setAction(null);
        setStreamingLines(undefined);
        return;
      }
    }
    startStreamingRun(true);
  };

  const isTransitional =
    action === "stopping" ||
    action === "restarting" ||
    action === "rebuilding" ||
    action === "building";

  const statusLabel: Record<string, string> = {
    stopping: "Stopping...",
    restarting: "Restarting...",
    rebuilding: "Rebuilding...",
    building: "Building...",
  };

  return (
    <div className="detail">
      {/* Header Card */}
      <div className="project-card">
        <div className="project-card-top">
          <div>
            <h2 className="project-card-name">{project.name}</h2>
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
          <div className="btn-group">
            <button type="button" className="btn btn-ghost btn-sm" onClick={onEdit}>
              Edit
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm btn-danger"
              onClick={() => {
                if (confirm(`Delete "${project.name}"? This cannot be undone.`)) onDelete();
              }}
            >
              Delete
            </button>
          </div>
        </div>
        <div className="project-card-status">
          <div className="project-card-status-left">
            <span className={`badge-status ${displayStatus}`}>
              <span className={isTransitional ? "spinner" : "dot"} />
              {displayStatus}
            </span>
          </div>
          <div className="btn-group">
            {actionLoading ? (
              <button type="button" className="btn btn-sm" disabled>
                {statusLabel[action as string] || "Working..."}
              </button>
            ) : isRunning ? (
              <>
                <button type="button" className="btn btn-stop btn-sm" onClick={handleStop}>
                  Stop
                </button>
                <button type="button" className="btn btn-sm" onClick={handleRestart}>
                  Restart
                </button>
                <button type="button" className="btn btn-sm" onClick={handleRebuild}>
                  Rebuild
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="btn btn-run btn-sm"
                  disabled={isBuilding || !project.github_url}
                  onClick={handleRun}
                >
                  {isBuilding ? "Building..." : "Run"}
                </button>
                {project.image_tag && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={isBuilding}
                    onClick={handleRebuild}
                  >
                    Rebuild
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Tabs + Content */}
      <div className="section">
        <div className="log-tabs">
          <button
            type="button"
            className={`log-tab ${tab === "build" ? "active" : ""}`}
            onClick={() => setTab("build")}
          >
            Build
          </button>
          <button
            type="button"
            className={`log-tab ${tab === "logs" ? "active" : ""}`}
            onClick={() => setTab("logs")}
          >
            Logs
          </button>
          <button
            type="button"
            className={`log-tab ${tab === "terminal" ? "active" : ""}`}
            onClick={() => setTab("terminal")}
          >
            Terminal
          </button>
          <button
            type="button"
            className={`log-tab ${tab === "env" ? "active" : ""}`}
            onClick={() => setTab("env")}
          >
            Env
          </button>
        </div>

        <div className={`tab-panel ${tab === "build" ? "" : "hidden"}`}>
          <BuildOutput projectId={project.id} streamingLines={streamingLines} />
        </div>
        <div className={`tab-panel ${tab === "logs" ? "" : "hidden"}`}>
          <ContainerLogs projectId={project.id} running={isRunning} />
        </div>
        <div className={`tab-panel ${tab === "terminal" ? "" : "hidden"}`}>
          <Terminal projectId={project.id} running={isRunning} />
        </div>
        <div className={`tab-panel ${tab === "env" ? "" : "hidden"}`}>
          <EnvVars projectId={project.id} />
        </div>
      </div>
    </div>
  );
}
