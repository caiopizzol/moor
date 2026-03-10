import type { Project } from "../lib/api";
import { Logo } from "./Logo";

type Props = {
  projects: Project[];
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  onCreate: () => void;
  onLogout: () => void;
};

export function ProjectList({ projects, selectedId, onSelect, onCreate, onLogout }: Props) {
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
        {projects.length === 0 && (
          <div style={{ padding: "20px 12px", color: "var(--text-dim)", fontSize: 13 }}>
            No projects yet
          </div>
        )}
        {projects.map((p) => (
          <button
            type="button"
            key={p.id}
            className={`project-item ${p.id === selectedId ? "active" : ""}`}
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
