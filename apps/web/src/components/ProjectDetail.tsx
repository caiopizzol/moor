import { useCallback, useEffect, useState } from "react";
import { api, type PortMapping, type Project, type Run, type TerminalSession } from "../lib/api";
import { BuildOutput } from "./BuildOutput";
import { ContainerLogs } from "./ContainerLogs";
import { CronJobs } from "./CronJobs";
import { EnvVars } from "./EnvVars";
import { Terminal } from "./Terminal";

type Props = {
  project: Project;
  onUpdate: () => void;
  onEdit: () => void;
  onDelete: () => void;
};

type Tab = "build" | "logs" | "terminal" | "env" | "cron";
type Action = null | "stopping" | "restarting" | "rebuilding" | "building";

function formatElapsed(iso: string) {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hours}h ${remMins}m`;
}

export function ProjectDetail({ project, onUpdate, onEdit, onDelete }: Props) {
  const [action, setAction] = useState<Action>(null);
  const [tab, setTab] = useState<Tab>("build");
  const [streamingLines, setStreamingLines] = useState<string[] | undefined>(undefined);
  const [activeCronRuns, setActiveCronRuns] = useState<Run[]>([]);
  const [terminalSessions, setTerminalSessions] = useState<TerminalSession[]>([]);
  const [ports, setPorts] = useState<PortMapping[]>([]);

  const loadActiveCrons = useCallback(async () => {
    try {
      const { runs } = await api.runs.list(project.id);
      const active = runs.filter((r) => r.cron_id && !r.finished_at);
      const seen = new Set<number>();
      const deduped = active.filter((r) => {
        if (seen.has(r.cron_id!)) return false;
        seen.add(r.cron_id!);
        return true;
      });
      setActiveCronRuns(deduped);
    } catch {
      // ignore
    }
  }, [project.id]);

  const loadTerminalSessions = useCallback(async () => {
    try {
      const { sessions } = await api.terminalSessions.list(project.id);
      setTerminalSessions(sessions);
    } catch {
      // ignore
    }
  }, [project.id]);

  useEffect(() => {
    loadActiveCrons();
    loadTerminalSessions();
    const interval = setInterval(() => {
      loadActiveCrons();
      loadTerminalSessions();
    }, 5000);
    return () => clearInterval(interval);
  }, [loadActiveCrons, loadTerminalSessions]);

  const loadPorts = useCallback(() => {
    api.ports
      .list(project.id)
      .then(setPorts)
      .catch(() => {});
  }, [project.id]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload ports when status changes (e.g. after build)
  useEffect(() => {
    loadPorts();
  }, [loadPorts, project.status]);

  const isRunning = project.status === "running";
  const isBuilding = project.status === "building" || project.status === "pulling";
  const isImageProject = !!project.docker_image;
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
    rebuilding: isImageProject ? "Re-pulling..." : "Rebuilding...",
    building: isImageProject ? "Pulling..." : "Building...",
  };

  return (
    <div className="detail">
      {/* Header Card */}
      <div className="project-card">
        <div className="project-card-top">
          <div>
            <h2 className="project-card-name">{project.name}</h2>
            <div className="meta">
              {project.docker_image ? (
                <span className="source-badge image-badge">{project.docker_image}</span>
              ) : project.github_url ? (
                <>
                  <span className="source-badge github-badge">
                    {new URL(project.github_url).host + new URL(project.github_url).pathname}
                  </span>
                  <span>
                    {project.branch} &middot; {project.dockerfile}
                  </span>
                </>
              ) : (
                <span>No source configured</span>
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
            {ports.map((p) => (
              <span key={p.id} className="port-badge">
                :{p.host_port}
              </span>
            ))}
            {project.domain && (
              <a
                className="domain-badge"
                href={`https://${project.domain}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                {project.domain}
              </a>
            )}
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
                  {isImageProject ? "Re-pull" : "Rebuild"}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="btn btn-run btn-sm"
                  disabled={isBuilding || (!project.github_url && !project.docker_image)}
                  onClick={handleRun}
                >
                  {isBuilding
                    ? project.status === "pulling"
                      ? "Pulling..."
                      : "Building..."
                    : "Run"}
                </button>
                {(project.image_tag || project.docker_image) && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={isBuilding}
                    onClick={handleRebuild}
                  >
                    {isImageProject ? "Re-pull" : "Rebuild"}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
        {(activeCronRuns.length > 0 || terminalSessions.length > 0) && (
          <div className="project-card-activity">
            {terminalSessions.map((s) => (
              <div key={s.execId} className="project-card-activity-item">
                <span className="spinner" />
                <span className="project-card-activity-name">{s.lastCommand || "/bin/sh"}</span>
                <span className="project-card-activity-cmd">{formatElapsed(s.startedAt)}</span>
                <button
                  type="button"
                  className="project-card-activity-stop"
                  onClick={() => api.terminalSessions.kill(s.execId).then(loadTerminalSessions)}
                >
                  Kill
                </button>
              </div>
            ))}
            {activeCronRuns.map((run) => (
              <div key={run.id} className="project-card-activity-item">
                <span className="spinner" />
                <span className="project-card-activity-name">{run.cron_name || "cron"}</span>
                {run.cron_command && (
                  <span className="project-card-activity-cmd">{run.cron_command}</span>
                )}
                <button
                  type="button"
                  className="project-card-activity-stop"
                  onClick={() => api.runs.stop(run.id).then(loadActiveCrons)}
                >
                  Stop
                </button>
              </div>
            ))}
            {activeCronRuns.length > 0 && (
              <button
                type="button"
                className="project-card-activity-link"
                onClick={() => setTab("cron")}
              >
                View runs &rarr;
              </button>
            )}
          </div>
        )}
      </div>

      {/* Tabs + Content */}
      <div className="section">
        <div className="log-tabs">
          <button
            type="button"
            className={`log-tab ${tab === "build" ? "active" : ""}`}
            onClick={() => setTab("build")}
          >
            {isImageProject ? "Pull" : "Build"}
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

          <button
            type="button"
            className={`log-tab ${tab === "cron" ? "active" : ""}`}
            onClick={() => setTab("cron")}
          >
            Cron
          </button>
        </div>

        <div className="tab-panel">
          {tab === "build" && (
            <BuildOutput
              projectId={project.id}
              streamingLines={streamingLines}
              isImageProject={isImageProject}
            />
          )}
          {tab === "logs" && <ContainerLogs projectId={project.id} running={isRunning} />}
          {tab === "terminal" && <Terminal projectId={project.id} running={isRunning} />}
          {tab === "env" && <EnvVars projectId={project.id} />}
          {tab === "cron" && <CronJobs projectId={project.id} />}
        </div>
      </div>
    </div>
  );
}
