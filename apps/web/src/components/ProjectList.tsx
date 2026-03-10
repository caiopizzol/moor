import type { Project } from "../lib/api";
import { Logo } from "./Logo";

type Props = {
  projects: Project[];
  selectedId: number | null;
  serverSelected: boolean;
  onSelect: (id: number | null) => void;
  onServerSelect: () => void;
  onCreate: () => void;
  onLogout: () => void;
};

export function ProjectList({
  projects,
  selectedId,
  serverSelected,
  onSelect,
  onServerSelect,
  onCreate,
  onLogout,
}: Props) {
  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <button type="button" className="sidebar-title" onClick={() => onSelect(null)}>
          <Logo />
        </button>
        <div style={{ display: "flex", gap: 6 }}>
          <button type="button" className="btn btn-sm" onClick={onCreate}>
            + New
          </button>
          <button type="button" className="btn btn-sm" onClick={onLogout} title="Sign out">
            Logout
          </button>
        </div>
      </div>
      <div className="sidebar-list">
        <button
          type="button"
          className={`project-item server-item ${serverSelected ? "active" : ""}`}
          onClick={onServerSelect}
        >
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
