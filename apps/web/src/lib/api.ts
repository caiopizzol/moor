export type Project = {
  id: number;
  name: string;
  github_url: string | null;
  branch: string;
  dockerfile: string;
  image_tag: string | null;
  container_id: string | null;
  status: string;
  created_at: string;
};

export type Cron = {
  id: number;
  project_id: number;
  name: string;
  schedule: string;
  command: string;
  enabled: number;
  created_at: string;
};

export type EnvVar = {
  id: number;
  project_id: number;
  key: string;
  value: string;
};

export type Run = {
  id: number;
  cron_id: number | null;
  project_id: number;
  started_at: string;
  finished_at: string | null;
  exit_code: number | null;
  stdout: string | null;
  stderr: string | null;
  duration_ms: number | null;
  cron_name?: string;
};

async function request<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (res.status === 401 && !path.startsWith("/api/auth/")) {
    window.dispatchEvent(new CustomEvent("moor:unauthorized"));
    throw new Error("Unauthorized");
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status}: ${body}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  auth: {
    status: () => request<{ setup: boolean; authenticated: boolean }>("/api/auth/status"),
    setup: (password: string) =>
      request<{ ok: boolean }>("/api/auth/setup", {
        method: "POST",
        body: JSON.stringify({ password }),
      }),
    login: (password: string) =>
      request<{ ok: boolean }>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ password }),
      }),
    logout: () => request<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
  },
  projects: {
    list: () => request<Project[]>("/api/projects"),
    get: (id: number) => request<Project>(`/api/projects/${id}`),
    create: (data: Partial<Project>) =>
      request<Project>("/api/projects", { method: "POST", body: JSON.stringify(data) }),
    update: (id: number, data: Partial<Project>) =>
      request<Project>(`/api/projects/${id}`, { method: "PUT", body: JSON.stringify(data) }),
    delete: (id: number) => request<void>(`/api/projects/${id}`, { method: "DELETE" }),
    build: (id: number) =>
      request<{ message: string }>(`/api/projects/${id}/build`, { method: "POST" }),
    start: (id: number) =>
      request<{ message: string }>(`/api/projects/${id}/start`, { method: "POST" }),
    stop: (id: number) =>
      request<{ message: string }>(`/api/projects/${id}/stop`, { method: "POST" }),
    run: (id: number) =>
      request<{ message: string }>(`/api/projects/${id}/run`, { method: "POST" }),
    logs: (id: number, tail = 100) =>
      request<{ logs: string }>(`/api/projects/${id}/logs?tail=${tail}`),
    exec: (id: number, command: string) =>
      request<{ exitCode: number; stdout: string; stderr: string }>(`/api/projects/${id}/exec`, {
        method: "POST",
        body: JSON.stringify({ command }),
      }),
    buildOutput: (id: number) =>
      request<Run | { output: null }>(`/api/projects/${id}/build-output`),
  },
  crons: {
    list: (projectId: number) => request<Cron[]>(`/api/projects/${projectId}/crons`),
    create: (projectId: number, data: Partial<Cron>) =>
      request<Cron>(`/api/projects/${projectId}/crons`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
    update: (id: number, data: Partial<Cron>) =>
      request<Cron>(`/api/crons/${id}`, { method: "PUT", body: JSON.stringify(data) }),
    delete: (id: number) => request<void>(`/api/crons/${id}`, { method: "DELETE" }),
  },
  envs: {
    list: (projectId: number) => request<EnvVar[]>(`/api/projects/${projectId}/envs`),
    set: (projectId: number, vars: { key: string; value: string }[]) =>
      request<EnvVar[]>(`/api/projects/${projectId}/envs`, {
        method: "PUT",
        body: JSON.stringify(vars),
      }),
    delete: (projectId: number, key: string) =>
      request<void>(`/api/projects/${projectId}/envs/${encodeURIComponent(key)}`, {
        method: "DELETE",
      }),
  },
  runs: {
    list: (projectId: number, page = 1) =>
      request<{ runs: Run[]; total: number }>(`/api/projects/${projectId}/runs?page=${page}`),
    get: (id: number) => request<Run>(`/api/runs/${id}`),
  },
};
