export function errorResponse(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

export type JsonObjectResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; response: Response };

export async function readJsonObject(req: Request): Promise<JsonObjectResult> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return { ok: false, response: errorResponse("invalid JSON body", 400) };
  }

  if (!isJsonObject(raw)) {
    return {
      ok: false,
      response: errorResponse("request body must be a JSON object", 400),
    };
  }

  return { ok: true, value: raw };
}

export async function responseErrorMessage(response: Response): Promise<string> {
  const text = await response.text();
  return parseErrorMessage(text, response.status);
}

// Mirrors packages/contract parseErrorMessage; the API stays dependency-free.
function parseErrorMessage(body: string, status: number): string {
  if (!body) return `HTTP ${status}`;

  try {
    const parsed = JSON.parse(body) as unknown;
    if (isJsonObject(parsed) && "error" in parsed) {
      const error = parsed.error;
      return typeof error === "string" ? error : JSON.stringify(error);
    }
  } catch {
    return body;
  }

  return body;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
