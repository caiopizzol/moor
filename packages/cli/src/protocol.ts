import { clientConfigError, readErrorMessage } from "./client";

export type CommandOutput = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
};

export const defaultCommandOutput: CommandOutput = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

export function formatError(message: string, status: number | undefined, json: boolean): string {
  if (!json) return `Error: ${message}`;
  return JSON.stringify({ error: message, ...(status === undefined ? {} : { status }) });
}

export function writeError(
  output: CommandOutput,
  message: string,
  json: boolean,
  status?: number,
): void {
  output.stderr(`${formatError(message, status, json)}\n`);
}

export async function formatResponseError(
  response: Response,
  json: boolean,
  humanContext?: string,
): Promise<string> {
  const copy = response.clone();
  let message: string;
  try {
    message = await readErrorMessage(response);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  if (!json) {
    return formatError(
      humanContext ? `${humanContext}: ${message}` : message,
      response.status,
      false,
    );
  }

  try {
    const body: unknown = await copy.json();
    if (typeof body === "object" && body !== null && !Array.isArray(body)) {
      const fields = body as Record<string, unknown>;
      const structuredError =
        typeof fields.error === "object" && fields.error !== null && !Array.isArray(fields.error)
          ? fields.error
          : undefined;
      const error =
        typeof fields.error === "string"
          ? undefined
          : typeof fields.message === "string"
            ? fields.message
            : `HTTP ${response.status}`;
      return JSON.stringify({
        ...fields,
        ...(structuredError === undefined ? {} : { error_details: structuredError }),
        ...(error === undefined ? {} : { error }),
        status: response.status,
      });
    }
  } catch {
    // Use the normalized response message below.
  }
  return formatError(message, response.status, true);
}

export async function requestJson<T>(
  request: () => Promise<Response>,
  json: boolean,
  humanError: string,
  output: CommandOutput,
): Promise<{ ok: true; value: T } | { ok: false }> {
  const configError = clientConfigError();
  if (configError) {
    writeError(output, configError, json);
    return { ok: false };
  }

  let response: Response;
  try {
    response = await request();
  } catch (error) {
    writeError(output, error instanceof Error ? error.message : String(error), json);
    return { ok: false };
  }

  if (!response.ok) {
    output.stderr(`${await formatResponseError(response, json, humanError)}\n`);
    return { ok: false };
  }

  try {
    return { ok: true, value: (await response.json()) as T };
  } catch (error) {
    writeError(output, error instanceof Error ? error.message : String(error), json);
    return { ok: false };
  }
}
