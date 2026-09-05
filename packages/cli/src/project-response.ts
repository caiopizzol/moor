import type { Project } from "../../contract/src/index";
import { apiGet } from "./client";
import { type CommandOutput, requestJson, writeError } from "./protocol";

export async function requestProjects(json: boolean, output: CommandOutput) {
  const result = await requestJson<Project[]>(
    () => apiGet("/api/projects"),
    json,
    "Failed to list projects",
    output,
  );
  if (!result.ok) return result;
  if (
    !Array.isArray(result.value) ||
    result.value.some(
      (project) =>
        !project ||
        !Number.isSafeInteger(project.id) ||
        project.id <= 0 ||
        typeof project.name !== "string" ||
        !project.name.trim(),
    )
  ) {
    writeError(output, "Invalid project response", json);
    return { ok: false } as const;
  }
  return result;
}
