import { useCallback, useEffect, useState } from "react";
import { LoginPage } from "./components/LoginPage";
import { ProjectDetail } from "./components/ProjectDetail";
import { ProjectList } from "./components/ProjectList";
import { ProjectModal } from "./components/ProjectModal";
import { SetupPage } from "./components/SetupPage";
import { api, type Project } from "./lib/api";

type AuthState = "loading" | "setup" | "login" | "authenticated";

function getIdFromPath(): number | null {
  const match = window.location.pathname.match(/^\/projects\/(\d+)$/);
  return match ? Number(match[1]) : null;
}

export function App() {
  const [authState, setAuthState] = useState<AuthState>("loading");
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(getIdFromPath);
  const [modal, setModal] = useState<
    { mode: "create" } | { mode: "edit"; project: Project } | null
  >(null);

  const checkAuth = useCallback(async () => {
    try {
      const { setup, authenticated } = await api.auth.status();
      if (!setup) setAuthState("setup");
      else if (!authenticated) setAuthState("login");
      else setAuthState("authenticated");
    } catch {
      setAuthState("login");
    }
  }, []);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  useEffect(() => {
    const handler = () => setAuthState("login");
    window.addEventListener("moor:unauthorized", handler);
    return () => window.removeEventListener("moor:unauthorized", handler);
  }, []);

  const load = useCallback(async () => {
    const data = await api.projects.list();
    setProjects(data);
  }, []);

  useEffect(() => {
    if (authState === "authenticated") load();
  }, [authState, load]);

  const navigate = useCallback((id: number | null) => {
    setSelectedId(id);
    const path = id ? `/projects/${id}` : "/";
    if (window.location.pathname !== path) {
      history.pushState(null, "", path);
    }
  }, []);

  useEffect(() => {
    const onPopState = () => setSelectedId(getIdFromPath());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "n") {
        e.preventDefault();
        setModal({ mode: "create" });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const selected = projects.find((p) => p.id === selectedId) ?? null;

  if (authState === "loading") {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h1>Moor</h1>
        </div>
      </div>
    );
  }

  if (authState === "setup") {
    return <SetupPage onSuccess={() => setAuthState("authenticated")} />;
  }

  if (authState === "login") {
    return <LoginPage onSuccess={() => setAuthState("authenticated")} />;
  }

  return (
    <div className="app">
      <ProjectList
        projects={projects}
        selectedId={selectedId}
        onSelect={navigate}
        onCreate={() => setModal({ mode: "create" })}
        onLogout={async () => {
          await api.auth.logout();
          setAuthState("login");
        }}
      />
      {selected ? (
        <ProjectDetail
          key={selected.id}
          project={selected}
          onUpdate={load}
          onEdit={() => setModal({ mode: "edit", project: selected })}
          onDelete={async () => {
            await api.projects.delete(selected.id);
            navigate(null);
            await load();
          }}
        />
      ) : (
        <div className="detail-empty">Select a project or press N to create one</div>
      )}
      {modal && (
        <ProjectModal
          project={modal.mode === "edit" ? modal.project : undefined}
          onClose={() => setModal(null)}
          onSave={async (data) => {
            if (modal.mode === "edit") {
              await api.projects.update(modal.project.id, data);
            } else {
              const created = await api.projects.create(data);
              navigate(created.id);
            }
            await load();
            setModal(null);
          }}
        />
      )}
    </div>
  );
}
