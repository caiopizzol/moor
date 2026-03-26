export type Project = {
  id: number;
  name: string;
  github_url: string | null;
  docker_image: string | null;
  branch: string;
  dockerfile: string;
  image_tag: string | null;
  container_id: string | null;
  status: string;
  domain: string | null;
  domain_port: number | null;
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

export type PortMapping = {
  id: number;
  project_id: number;
  host_port: number;
  container_port: number;
  protocol: string;
};

export type TerminalSession = {
  execId: string;
  projectId: number;
  startedAt: string;
  lastCommand: string;
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
  cron_command?: string;
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
    runStream: async (
      id: number,
      onLog: (text: string) => void,
      onDone: () => void,
      onError: (err: string) => void,
      noCache = false,
    ) => {
      const params = noCache ? "?nocache=true" : "";
      const res = await fetch(`/api/projects/${id}/run${params}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (res.status === 401) {
        window.dispatchEvent(new CustomEvent("moor:unauthorized"));
        return;
      }
      if (!res.ok || !res.body) {
        onError(await res.text());
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";
        for (const part of parts) {
          const eventMatch = part.match(/^event: (\w+)\ndata: (.+)$/s);
          if (!eventMatch) continue;
          const [, event, raw] = eventMatch;
          const data = JSON.parse(raw) as string;
          if (event === "log") onLog(data);
          else if (event === "done") onDone();
          else if (event === "error") onError(data);
        }
      }
    },
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
    run: (id: number) => request<{ ok: boolean }>(`/api/crons/${id}/run`, { method: "POST" }),
  },
  ports: {
    list: (projectId: number) => request<PortMapping[]>(`/api/projects/${projectId}/ports`),
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
  dns: {
    check: (domain: string) =>
      request<{ resolves: boolean; ip: string | null; serverIp: string | null }>("/api/dns-check", {
        method: "POST",
        body: JSON.stringify({ domain }),
      }),
  },
  server: {
    stats: () =>
      request<{
        hostname: string;
        os: string;
        uptime: string;
        cpu: { percent: number; cores: number };
        memory: { total: string; used: string; percent: number };
        disk: { total: string; used: string; percent: number };
        containers: { running: number; total: number };
      }>("/api/server/stats"),
  },
  runs: {
    list: (projectId: number, page = 1) =>
      request<{ runs: Run[]; total: number }>(`/api/projects/${projectId}/runs?page=${page}`),
    get: (id: number) => request<Run>(`/api/runs/${id}`),
    stop: (id: number) => request<{ ok: boolean }>(`/api/runs/${id}/stop`, { method: "POST" }),
  },
  terminalSessions: {
    list: (projectId: number) =>
      request<{ sessions: TerminalSession[] }>(`/api/projects/${projectId}/terminal-sessions`),
    kill: (execId: string) =>
      request<{ ok: boolean }>(`/api/terminal-sessions/${execId}/kill`, { method: "POST" }),
  },
};
