import type { SseReadResult } from "./tools/context";

export async function readSSE(res: Response): Promise<SseReadResult> {
  const reader = res.body?.getReader();
  if (!reader) return { logs: "" };

  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "";
  let logs = "";
  let error: string | undefined;
  let structuredError: SseReadResult["structuredError"];
  let deploy: SseReadResult["deploy"];

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
        const data = JSON.parse(line.slice(6));
        if (currentEvent === "log") logs += data;
        else if (currentEvent === "error") error = data;
        else if (currentEvent === "structured-error") structuredError = data;
        else if (currentEvent === "deploy") deploy = data;
        currentEvent = "";
      }
    }
  }
  return { logs, error, structuredError, deploy };
}
