import {
  createMoorApiClient,
  type FetchLike,
  type MoorApiClient,
  type Project,
  parseErrorMessage,
} from "../../contract/src/index";

import { resolveConfig } from "./config";

export function clientConfigError(): string | undefined {
  try {
    resolveConfig();
  } catch (error) {
    return error instanceof Error ? error.message : "Invalid client configuration";
  }
}

function getConfig() {
  try {
    return resolveConfig();
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : "Invalid client configuration"}`,
    );
    process.exit(1);
  }
}

async function rawResponseRequest(
  callClient: (client: MoorApiClient) => Promise<unknown>,
): Promise<Response> {
  const config = getConfig();
  let rawResponse: Response | undefined;
  const fetchRawResponse: FetchLike = async (input, init) => {
    rawResponse = await globalThis.fetch(
      input,
      config.saved ? { ...init, redirect: "error" } : init,
    );
    const body: unknown =
      config.saved && rawResponse.status === 401
        ? await rawResponse
            .clone()
            .json()
            .catch(() => null)
        : null;
    if (
      body &&
      typeof body === "object" &&
      "error" in body &&
      body.error === "Unauthorized" &&
      Object.keys(body).length === 1
    ) {
      await rawResponse.body?.cancel();
      rawResponse = Response.json(
        {
          error:
            "Saved login expired or was revoked. Run moor logout, then moor login <server-url>.",
        },
        { status: 401 },
      );
    }
    return new Response(null, { status: 204 });
  };
  const client = createMoorApiClient({
    ...config,
    fetch: fetchRawResponse,
  });

  await callClient(client);
  if (!rawResponse) throw new Error("No response received");
  return rawResponse;
}

export async function apiGet(path: string): Promise<Response> {
  return rawResponseRequest((client) => client.get(path));
}

export async function apiPost(path: string, body?: unknown): Promise<Response> {
  return rawResponseRequest((client) => client.post(path, body));
}

export async function apiPut(path: string, body: unknown): Promise<Response> {
  return rawResponseRequest((client) => client.put(path, body));
}

export async function readErrorMessage(res: Response): Promise<string> {
  const text = await res.text();
  return parseErrorMessage(text, res.status);
}

export function findProject(projects: Project[], selector: string): Project | undefined {
  const selectorId = /^\d+$/.test(selector) ? Number(selector) : undefined;
  return (
    projects.find((project) => project.name === selector) ??
    (Number.isSafeInteger(selectorId)
      ? projects.find((project) => project.id === selectorId)
      : undefined)
  );
}

export async function streamSSE(
  res: Response,
  handlers: {
    onEvent?: (event: { event: string; data: unknown }) => void;
    onLog?: (text: string) => void;
    onError?: (text: string) => void;
    onDone?: (text: string) => void;
  },
): Promise<void> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (line.startsWith("event: ")) {
        currentEvent = line.slice(7).trim();
      } else if (line.startsWith("data: ")) {
        const event = currentEvent;
        const data: unknown = JSON.parse(line.slice(6));
        handlers.onEvent?.({ event, data });
        if (event === "log" && typeof data === "string") handlers.onLog?.(data);
        else if (event === "error" && typeof data === "string") handlers.onError?.(data);
        else if (event === "done" && typeof data === "string") handlers.onDone?.(data);
        currentEvent = "";
      }
      // Ignore keepalive comments starting with ":"
    }
  }
}
