import type {
  BuildOutputResponse,
  ContainerStats,
  CreateCronRequest,
  CreateProjectRequest,
  Cron,
  EnvVar,
  ExecResponse,
  ListRunsResponse,
  ListTerminalSessionsResponse,
  LogsResponse,
  PortMapping,
  Project,
  ProjectHistory,
  Run,
  ServerStats,
  SetEnvVarsRequest,
  UpdateCronRequest,
  UpdateProjectRequest,
} from "@moor-sh/contract";

export type {
  ContainerStats,
  Cron,
  EnvVar,
  PortMapping,
  Project,
  ProjectHistory,
  Run,
  TerminalSession,
} from "@moor-sh/contract";

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
    throw new Error(`${res.status}: ${await readErrorMessage(res)}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  auth: {
    status: async (): Promise<{ authenticated: boolean; needsSetup?: true }> => {
      try {
        return await request<{ authenticated: boolean }>("/api/auth/status");
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("503:")) {
          return { authenticated: false, needsSetup: true };
        }
        throw err;
      }
    },
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
    create: (data: CreateProjectRequest) =>
      request<Project>("/api/projects", { method: "POST", body: JSON.stringify(data) }),
    update: (id: number, data: UpdateProjectRequest) =>
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
    history: (id: number, fromMs: number, toMs: number) =>
      request<ProjectHistory>(`/api/projects/${id}/stats/history?from=${fromMs}&to=${toMs}`),
    containerStats: (id: number) => request<ContainerStats>(`/api/projects/${id}/container-stats`),
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
        onError(await readErrorMessage(res));
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
    logs: (id: number, since?: number) =>
      request<LogsResponse>(`/api/projects/${id}/logs${since ? `?since=${since}` : ""}`),
    exec: (id: number, command: string) =>
      request<ExecResponse>(`/api/projects/${id}/exec`, {
        method: "POST",
        body: JSON.stringify({ command }),
      }),
    buildOutput: (id: number) => request<BuildOutputResponse>(`/api/projects/${id}/build-output`),
  },
  crons: {
    list: (projectId: number) => request<Cron[]>(`/api/projects/${projectId}/crons`),
    create: (projectId: number, data: CreateCronRequest) =>
      request<Cron>(`/api/projects/${projectId}/crons`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
    update: (id: number, data: UpdateCronRequest) =>
      request<Cron>(`/api/crons/${id}`, { method: "PUT", body: JSON.stringify(data) }),
    delete: (id: number) => request<void>(`/api/crons/${id}`, { method: "DELETE" }),
    run: (id: number) => request<{ ok: boolean }>(`/api/crons/${id}/run`, { method: "POST" }),
  },
  ports: {
    list: (projectId: number) => request<PortMapping[]>(`/api/projects/${projectId}/ports`),
  },
  envs: {
    list: (projectId: number) => request<EnvVar[]>(`/api/projects/${projectId}/envs`),
    set: (projectId: number, vars: SetEnvVarsRequest) =>
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
    stats: () => request<ServerStats>("/api/server/stats"),
  },
  runs: {
    list: (projectId: number, page = 1) =>
      request<ListRunsResponse>(`/api/projects/${projectId}/runs?page=${page}`),
    get: (id: number) => request<Run>(`/api/runs/${id}`),
    stop: (id: number) => request<{ ok: boolean }>(`/api/runs/${id}/stop`, { method: "POST" }),
  },
  terminalSessions: {
    list: (projectId: number) =>
      request<ListTerminalSessionsResponse>(`/api/projects/${projectId}/terminal-sessions`),
    kill: (execId: string) =>
      request<{ ok: boolean }>(`/api/terminal-sessions/${execId}/kill`, { method: "POST" }),
  },
};

async function readErrorMessage(res: Response): Promise<string> {
  const text = await res.text();
  if (!text) return `HTTP ${res.status}`;

  try {
    const parsed = JSON.parse(text) as unknown;
    if (isJsonObject(parsed) && "error" in parsed) {
      const error = parsed.error;
      return typeof error === "string" ? error : JSON.stringify(error);
    }
  } catch {
    return text;
  }

  return text;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
