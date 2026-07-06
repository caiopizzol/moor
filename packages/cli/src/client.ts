import {
  createMoorApiClient,
  type FetchLike,
  type MoorApiClient,
  type Project,
  parseErrorMessage,
} from "../../contract/src/index";

function getConfig(): { baseUrl: string; apiKey: string } {
  const baseUrl = process.env.MOOR_URL;
  const apiKey = process.env.MOOR_API_KEY;
  if (!baseUrl) {
    console.error("Error: MOOR_URL is not set");
    process.exit(1);
  }
  if (!apiKey) {
    console.error("Error: MOOR_API_KEY is not set");
    process.exit(1);
  }
  return { baseUrl: baseUrl.replace(/\/$/, ""), apiKey };
}

async function rawResponseRequest(
  callClient: (client: MoorApiClient) => Promise<unknown>,
): Promise<Response> {
  let rawResponse: Response | undefined;
  const fetchRawResponse: FetchLike = async (input, init) => {
    rawResponse = await globalThis.fetch(input, init);
    return new Response(null, { status: 204 });
  };
  const client = createMoorApiClient({
    ...getConfig(),
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

export async function resolveProject(nameOrId: string): Promise<Project> {
  const res = await apiGet("/api/projects");
  if (!res.ok) {
    console.error(`Failed to list projects: ${res.status}`);
    process.exit(1);
  }
  const projects = (await res.json()) as Project[];
  const match = projects.find((p) => p.name === nameOrId || String(p.id) === nameOrId);
  if (!match) {
    console.error(`Project "${nameOrId}" not found`);
    process.exit(1);
  }
  return match;
}

export async function streamSSE(
  res: Response,
  handlers: {
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
        const data = JSON.parse(line.slice(6)) as string;
        if (currentEvent === "log") handlers.onLog?.(data);
        else if (currentEvent === "error") handlers.onError?.(data);
        else if (currentEvent === "done") handlers.onDone?.(data);
        currentEvent = "";
      }
      // Ignore keepalive comments starting with ":"
    }
  }
}
