export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type MoorApiClientOptions = {
  baseUrl: string;
  apiKey: string;
  fetch?: FetchLike;
};

export type MoorApiClient = {
  get: <T = unknown>(path: string, init?: RequestInit) => Promise<T>;
  post: <T = unknown>(path: string, body?: unknown, init?: RequestInit) => Promise<T>;
  put: <T = unknown>(path: string, body: unknown, init?: RequestInit) => Promise<T>;
  delete: <T = unknown>(path: string, init?: RequestInit) => Promise<T>;
};

export class MoorApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, message: string, body = "") {
    super(message);
    this.name = "MoorApiError";
    this.status = status;
    this.body = body;
  }
}

export function createMoorApiClient(options: MoorApiClientOptions): MoorApiClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const apiKey = options.apiKey;
  const fetchImpl = options.fetch ?? globalThis.fetch;

  async function request<T>(method: string, path: string, body?: unknown, init?: RequestInit) {
    const hasBody = body !== undefined;
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${apiKey}`);
    if (!headers.has("Accept")) headers.set("Accept", "application/json");
    if (hasBody && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

    const res = await fetchImpl(joinUrl(baseUrl, path), {
      ...init,
      method,
      headers,
      body: hasBody ? JSON.stringify(body) : init?.body,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new MoorApiError(res.status, parseErrorMessage(text, res.status), text);
    }

    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  return {
    get: <T = unknown>(path: string, init?: RequestInit) =>
      request<T>("GET", path, undefined, init),
    post: <T = unknown>(path: string, body?: unknown, init?: RequestInit) =>
      request<T>("POST", path, body, init),
    put: <T = unknown>(path: string, body: unknown, init?: RequestInit) =>
      request<T>("PUT", path, body, init),
    delete: <T = unknown>(path: string, init?: RequestInit) =>
      request<T>("DELETE", path, undefined, init),
  };
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function joinUrl(baseUrl: string, path: string): string {
  if (path.startsWith("/")) return `${baseUrl}${path}`;
  return `${baseUrl}/${path}`;
}

function parseErrorMessage(body: string, status: number): string {
  if (body) {
    try {
      const parsed = JSON.parse(body) as unknown;
      if (isJsonObject(parsed) && "error" in parsed) {
        const error = parsed.error;
        if (typeof error === "string") return error;
        return JSON.stringify(error);
      }
    } catch {
      return body;
    }
    return body;
  }
  return `HTTP ${status}`;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
