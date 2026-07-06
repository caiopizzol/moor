import type { Project } from "../../../contract/src/index";

export type ApiResponseClient = {
  get(path: string): Promise<Response>;
  post(path: string, body?: unknown): Promise<Response>;
  put(path: string, body: unknown): Promise<Response>;
  delete(path: string): Promise<Response>;
};

export type SseReadResult = {
  logs: string;
  error?: string;
  structuredError?: { code: string; message: string };
};

export type ToolContext = {
  apiResponse: ApiResponseClient;
  resolveProject(name: string): Promise<Project>;
  readErrorMessage(res: Response): Promise<string>;
  readSSE(res: Response): Promise<SseReadResult>;
};
