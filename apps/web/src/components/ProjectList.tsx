import type { Project } from "../lib/api";
import { Logo } from "./Logo";

type Props = {
  projects: Project[];
  selectedId: number | null;
  serverSelected: boolean;
  collapsed: boolean;
  onSelect: (id: number | null) => void;
  onServerSelect: () => void;
  onCreate: () => void;
  onLogout: () => void;
  onToggleCollapse: () => void;
};

const CollapseIcon = ({ collapsed }: { collapsed: boolean }) => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <line x1="9" y1="3" x2="9" y2="21" />
    {collapsed ? <polyline points="13 9 16 12 13 15" /> : <polyline points="15 9 12 12 15 15" />}
  </svg>
);

const ServerIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
    <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
    <line x1="6" y1="6" x2="6.01" y2="6" />
    <line x1="6" y1="18" x2="6.01" y2="18" />
  </svg>
);

function CollapsedSidebar({
  projects,
  selectedId,
  serverSelected,
  onSelect,
  onServerSelect,
  onToggleCollapse,
}: Pick<
  Props,
  "projects" | "selectedId" | "serverSelected" | "onSelect" | "onServerSelect" | "onToggleCollapse"
>) {
  return (
    <div className="sidebar sidebar-collapsed">
      <div className="sidebar-header">
        <button
          type="button"
          className="sidebar-collapse-toggle"
          onClick={onToggleCollapse}
          title="Expand sidebar"
        >
          <CollapseIcon collapsed />
        </button>
      </div>
      <div className="sidebar-list">
        <button
          type="button"
          className={`icon-nav-item ${serverSelected ? "active" : ""}`}
          onClick={onServerSelect}
        >
          <ServerIcon />
          <span className="icon-tooltip">Server</span>
        </button>
        <div className="sidebar-divider" />
        {projects.map((p) => (
          <button
            type="button"
            key={p.id}
            className={`icon-nav-item ${!serverSelected && p.id === selectedId ? "active" : ""}`}
            onClick={() => onSelect(p.id)}
          >
            <span className="project-letter">{p.name[0]?.toUpperCase()}</span>
            <span className={`status-dot-overlay ${p.status}`} />
            <span className="icon-tooltip">{p.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function ProjectList({
  projects,
  selectedId,
  serverSelected,
  collapsed,
  onSelect,
  onServerSelect,
  onCreate,
  onLogout,
  onToggleCollapse,
}: Props) {
  if (collapsed) {
    return (
      <CollapsedSidebar
        projects={projects}
        selectedId={selectedId}
        serverSelected={serverSelected}
        onSelect={onSelect}
        onServerSelect={onServerSelect}
        onToggleCollapse={onToggleCollapse}
      />
    );
  }

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <button type="button" className="sidebar-title" onClick={() => onSelect(null)}>
          <Logo />
        </button>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <button type="button" className="btn btn-sm" onClick={onCreate}>
            + New
          </button>
          <button type="button" className="btn btn-sm" onClick={onLogout} title="Sign out">
            Logout
          </button>
          <button
            type="button"
            className="sidebar-collapse-toggle"
            onClick={onToggleCollapse}
            title="Collapse sidebar"
          >
            <CollapseIcon collapsed={false} />
          </button>
        </div>
      </div>
      <div className="sidebar-list">
        <button
          type="button"
          className={`project-item server-item ${serverSelected ? "active" : ""}`}
          onClick={onServerSelect}
        >
          <ServerIcon />
          <span className="name">Server</span>
        </button>
        <div className="sidebar-divider" />
        {projects.length === 0 && (
          <div style={{ padding: "20px 12px", color: "var(--text-dim)", fontSize: 13 }}>
            No projects yet
          </div>
        )}
        {projects.map((p) => (
          <button
            type="button"
            key={p.id}
            className={`project-item ${!serverSelected && p.id === selectedId ? "active" : ""}`}
            onClick={() => onSelect(p.id)}
          >
            <span className={`status-dot ${p.status}`} />
            <span className="name">{p.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
