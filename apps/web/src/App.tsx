import { useCallback, useEffect, useState } from "react";
import { LoginPage } from "./components/LoginPage";
import { Logo } from "./components/Logo";
import { ProjectDetail } from "./components/ProjectDetail";
import { ProjectList } from "./components/ProjectList";
import { ProjectModal } from "./components/ProjectModal";
import { ServerView } from "./components/ServerView";
import { api, type Project } from "./lib/api";

type AuthState = "loading" | "needs-setup" | "login" | "authenticated";

type View = { type: "project"; id: number } | { type: "server" } | null;

function getViewFromPath(): View {
  if (window.location.pathname === "/server") return { type: "server" };
  const match = window.location.pathname.match(/^\/projects\/(\d+)$/);
  if (match) return { type: "project", id: Number(match[1]) };
  return null;
}

export function App() {
  const [authState, setAuthState] = useState<AuthState>("loading");
  const [projects, setProjects] = useState<Project[]>([]);
  const [view, setView] = useState<View>(getViewFromPath);
  const [modal, setModal] = useState<
    { mode: "create" } | { mode: "edit"; project: Project } | null
  >(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem("moor:sidebar-collapsed") === "true",
  );

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem("moor:sidebar-collapsed", String(next));
      return next;
    });
  }, []);

  const checkAuth = useCallback(async () => {
    try {
      const result = await api.auth.status();
      if (result.needsSetup) setAuthState("needs-setup");
      else if (!result.authenticated) setAuthState("login");
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

  // Poll project list to keep sidebar status dots up to date
  useEffect(() => {
    if (authState !== "authenticated") return;
    const interval = setInterval(load, 3000);
    return () => clearInterval(interval);
  }, [authState, load]);

  const navigate = useCallback((id: number | null) => {
    setView(id ? { type: "project", id } : null);
    const path = id ? `/projects/${id}` : "/";
    if (window.location.pathname !== path) {
      history.pushState(null, "", path);
    }
  }, []);

  const navigateServer = useCallback(() => {
    setView({ type: "server" });
    if (window.location.pathname !== "/server") {
      history.pushState(null, "", "/server");
    }
  }, []);

  useEffect(() => {
    const onPopState = () => setView(getViewFromPath());
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

  const selectedId = view?.type === "project" ? view.id : null;
  const serverSelected = view?.type === "server";
  const selected = projects.find((p) => p.id === selectedId) ?? null;

  if (authState === "loading") {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <Logo size={28} />
        </div>
      </div>
    );
  }

  if (authState === "needs-setup") {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <Logo />
          <h1>Configuration required</h1>
          <p>
            No admin password is configured. Set <code>MOOR_INITIAL_PASSWORD</code> in your{" "}
            <code>docker-compose.yml</code> and restart the container.
          </p>
          <pre>{`services:
  moor:
    environment:
      - MOOR_INITIAL_PASSWORD=your-strong-password`}</pre>
          <p>
            Once an admin exists, this page becomes the login page. The env var is create-only -
            ignored on every subsequent boot - so it is safe to leave in place. Remove it after
            first login only if you want to keep the password out of the host's compose env.
          </p>
        </div>
      </div>
    );
  }

  if (authState === "login") {
    return <LoginPage onSuccess={() => setAuthState("authenticated")} />;
  }

  return (
    <div className="app">
      <ProjectList
        projects={projects}
        selectedId={selectedId}
        serverSelected={serverSelected}
        collapsed={sidebarCollapsed}
        onSelect={navigate}
        onServerSelect={navigateServer}
        onCreate={() => setModal({ mode: "create" })}
        onLogout={async () => {
          await api.auth.logout();
          setAuthState("login");
        }}
        onToggleCollapse={toggleSidebar}
      />
      {serverSelected ? (
        <ServerView />
      ) : selected ? (
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
