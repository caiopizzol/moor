import type {
  CreateProjectRequest,
  DeployRequest,
  DeploySummary,
  UpdateProjectRequest,
} from "../../../packages/contract/src/index";
import { validateGithubRepoUrl } from "../../../packages/contract/src/index";
import {
  validateFileContent,
  validateFileMode,
  validateFilePath,
  validateStringArray,
} from "../container-config";
import db from "../db";
import { deployProject, type Project, type ProjectActionResult } from "../deploy";
import { requireNotDraining } from "../drain";
import { errorResponse, readJsonObject, responseErrorMessage } from "../http";
import { validateCpus, validateMemoryLimitMb } from "../resource-limits";
import { validateVolumeName, validateVolumeTarget } from "../volumes";
import { listProjectEnvs, replaceProjectEnvs } from "./envs";
import { setProjectFile } from "./files";
import { createProject, updateProject } from "./projects";
import { addProjectVolume } from "./volumes";

type DeployRouteDeps = {
  requireNotDraining: () => Response | null;
  runProject: (project: Project, input: { noCache: boolean }) => Promise<ProjectActionResult>;
};

const defaultDeps: DeployRouteDeps = {
  requireNotDraining,
  runProject: deployProject,
};

const METADATA_KEYS = [
  "github_url",
  "docker_image",
  "branch",
  "dockerfile",
  "domain",
  "domain_port",
  "restart_policy",
  "memory_limit_mb",
  "cpus",
  "source_credential_id",
  "command",
  "entrypoint",
] as const;

export async function handleDeploy(
  req: Request,
  url: URL,
  deps: DeployRouteDeps = defaultDeps,
): Promise<Response | null> {
  if (url.pathname !== "/api/deploy") return null;
  if (req.method !== "POST") return null;

  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;
  const validationError = validateDeployInput(parsed.value);
  if (validationError) return errorResponse(validationError, 400);
  const input = parsed.value as DeployRequest;
  const shouldRun = input.run !== false;

  if (shouldRun) {
    const drained = deps.requireNotDraining();
    if (drained) return drained;
  }

  const existing = db
    .query("SELECT * FROM projects WHERE name = ?")
    .get(input.name) as Project | null;
  if (existing && !input.update_existing) {
    return errorResponse(
      `Project "${input.name}" already exists. Pass update_existing: true to update it.`,
      409,
    );
  }
  if (!existing) {
    const sources = (input.github_url ? 1 : 0) + (input.docker_image ? 1 : 0);
    if (sources !== 1) {
      return errorResponse("Provide exactly one of github_url or docker_image", 400);
    }
  }

  const normalizedDomain =
    input.domain === undefined ? undefined : input.domain?.trim().toLowerCase() || null;
  if (normalizedDomain) {
    const conflict = db
      .query("SELECT id, name FROM projects WHERE lower(trim(domain)) = ? AND id != ? LIMIT 1")
      .get(normalizedDomain, existing?.id ?? -1) as { id: number; name: string } | null;
    if (conflict) {
      return errorResponse(
        `Domain "${normalizedDomain}" is already used by project "${conflict.name}" (id=${conflict.id}). Refusing before Caddy reload.`,
        409,
      );
    }
  }

  let projectId: number;
  let projectName: string;
  let action: DeploySummary["action"];
  if (existing) {
    const updateBody: Record<string, unknown> = {};
    for (const key of METADATA_KEYS) {
      if (key in input) updateBody[key] = input[key];
    }
    if (normalizedDomain !== undefined) updateBody.domain = normalizedDomain;
    if (Object.keys(updateBody).length > 0) {
      const response = await updateProject(existing.id, updateBody as UpdateProjectRequest);
      if (!response.ok) return await stepError("update", response);
    }
    projectId = existing.id;
    projectName = existing.name;
    action = "updated";
  } else {
    const createBody: Record<string, unknown> = { name: input.name };
    for (const key of METADATA_KEYS) {
      if (key in input) createBody[key] = input[key];
    }
    if (normalizedDomain !== undefined) createBody.domain = normalizedDomain;
    const response = await createProject(createBody as CreateProjectRequest);
    if (!response.ok) return await stepError("create", response);
    const created = (await response.json()) as { id: number; name: string };
    projectId = created.id;
    projectName = created.name;
    action = "created";
  }

  for (const volume of input.volumes ?? []) {
    const response = addProjectVolume({ id: projectId, name: projectName }, volume);
    if (response.ok) continue;
    const message = await responseErrorMessage(response);
    if (response.status !== 409) {
      return errorResponse(`[volumes] failed to add ${volume.name}: ${message}`, response.status);
    }
    const match = db
      .query("SELECT target FROM project_volumes WHERE project_id = ? AND name = ?")
      .get(projectId, volume.name) as { target: string } | null;
    if (!match) {
      return errorResponse(
        `[volumes] conflict adding ${volume.name}: ${message} (no existing volume by that name; check for target collision)`,
        409,
      );
    }
    if (match.target !== volume.target) {
      return errorResponse(
        `[volumes] conflict adding ${volume.name}: existing target "${match.target}" differs from requested "${volume.target}". moor_deploy does not change mount targets; use moor_volume_remove + moor_volume_add explicitly.`,
        409,
      );
    }
  }

  for (const file of input.files ?? []) {
    const response = setProjectFile(projectId, file);
    if (!response.ok) {
      return errorResponse(
        `[files] failed to set ${file.path}: ${await responseErrorMessage(response)}`,
        response.status,
      );
    }
  }

  const envEntries = Object.entries(input.env ?? {});
  if (envEntries.length > 0) {
    const merged = new Map(listProjectEnvs(projectId).map(({ key, value }) => [key, value]));
    for (const [key, value] of envEntries) merged.set(key, value);
    replaceProjectEnvs(
      projectId,
      Array.from(merged, ([key, value]) => ({ key, value })),
    );
  }

  const summary: DeploySummary = {
    action,
    project_id: projectId,
    project_name: projectName,
    env_keys: envEntries.map(([key]) => key),
    run: shouldRun,
    env_changes_pending_restart:
      !shouldRun && envEntries.length > 0 && existing?.status === "running",
  };

  if (!shouldRun) return deployStreamResponse(summary);

  const project = db.query("SELECT * FROM projects WHERE id = ?").get(projectId) as Project | null;
  if (!project) return errorResponse("[run] Project not found after configuration", 500);
  const result = await deps.runProject(project, { noCache: false });
  if (result.kind === "response") return await stepError("run", result.response);
  if (result.kind === "json" && result.status !== undefined && result.status >= 400) {
    const error = `[run] ${JSON.stringify(result.body) ?? String(result.body)}`;
    return isObject(result.body)
      ? Response.json({ ...result.body, error }, { status: result.status })
      : errorResponse(error, result.status);
  }
  if (result.kind === "json") {
    return deployStreamResponse(summary, eventStream("done", result.body));
  }
  return deployStreamResponse(summary, result.stream);
}

function validateDeployInput(input: Record<string, unknown>): string | null {
  if (typeof input.name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(input.name)) {
    return "name must start alphanumeric; allowed chars: a-z A-Z 0-9 _ -";
  }
  if (input.github_url !== undefined && typeof input.github_url !== "string") {
    return "github_url must be a string";
  }
  if (input.docker_image !== undefined && typeof input.docker_image !== "string") {
    return "docker_image must be a string";
  }
  if (input.github_url && input.docker_image) {
    return "Cannot set both github_url and docker_image";
  }
  if (typeof input.github_url === "string" && input.github_url) {
    try {
      validateGithubRepoUrl(input.github_url);
    } catch (error) {
      return error instanceof Error ? error.message : "Invalid github_url";
    }
  }
  for (const key of ["branch", "dockerfile"] as const) {
    if (input[key] !== undefined && typeof input[key] !== "string") {
      return `${key} must be a string`;
    }
  }
  if (input.domain !== undefined && input.domain !== null && typeof input.domain !== "string") {
    return "domain must be a string or null";
  }
  if (
    input.domain_port !== undefined &&
    input.domain_port !== null &&
    (typeof input.domain_port !== "number" ||
      !Number.isInteger(input.domain_port) ||
      input.domain_port <= 0)
  ) {
    return "domain_port must be a positive integer or null";
  }
  if (
    input.restart_policy !== undefined &&
    (typeof input.restart_policy !== "string" ||
      !["no", "on-failure", "always", "unless-stopped"].includes(input.restart_policy))
  ) {
    return "restart_policy must be one of: no, on-failure, always, unless-stopped";
  }
  const memoryError = validateMemoryLimitMb(input.memory_limit_mb);
  if (memoryError) return memoryError;
  const cpuError = validateCpus(input.cpus);
  if (cpuError) return cpuError;
  const commandError = validateStringArray(input.command, "command");
  if (commandError) return commandError;
  const entrypointError = validateStringArray(input.entrypoint, "entrypoint");
  if (entrypointError) return entrypointError;
  if (input.run !== undefined && typeof input.run !== "boolean") return "run must be a boolean";
  if (input.update_existing !== undefined && typeof input.update_existing !== "boolean") {
    return "update_existing must be a boolean";
  }
  if (input.env !== undefined) {
    if (!isObject(input.env)) return "env must be an object of string values";
    if (Object.values(input.env).some((value) => typeof value !== "string")) {
      return "env must be an object of string values";
    }
  }
  if (input.volumes !== undefined && !Array.isArray(input.volumes)) {
    return "volumes must be an array";
  }
  if (Array.isArray(input.volumes)) {
    for (const volume of input.volumes) {
      if (!isObject(volume)) return "each volume must be an object";
      const nameError = validateVolumeName(volume.name);
      if (nameError) return nameError;
      const targetError = validateVolumeTarget(volume.target);
      if (targetError) return targetError;
    }
  }
  if (input.files !== undefined && !Array.isArray(input.files)) {
    return "files must be an array";
  }
  if (Array.isArray(input.files)) {
    for (const file of input.files) {
      if (!isObject(file)) return "each file must be an object";
      const pathError = validateFilePath(file.path);
      if (pathError) return pathError;
      const contentError = validateFileContent(file.content, file.env_ref);
      if (contentError) return contentError;
      const modeError = validateFileMode(file.mode);
      if (modeError) return modeError;
    }
  }
  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function stepError(step: string, response: Response): Promise<Response> {
  return errorResponse(`[${step}] ${await responseErrorMessage(response)}`, response.status);
}

function deployStreamResponse(
  summary: DeploySummary,
  inner?: ReadableStream<Uint8Array>,
): Response {
  const encoder = new TextEncoder();
  let innerReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(`event: deploy\ndata: ${JSON.stringify(summary)}\n\n`));
      if (inner) {
        innerReader = inner.getReader();
        try {
          while (!cancelled) {
            const { done, value } = await innerReader.read();
            if (done) break;
            if (!cancelled) controller.enqueue(value);
          }
        } finally {
          innerReader.releaseLock();
          innerReader = undefined;
        }
      } else {
        controller.enqueue(encoder.encode('event: done\ndata: "Configuration saved"\n\n'));
      }
      if (!cancelled) controller.close();
    },
    async cancel(reason) {
      cancelled = true;
      await innerReader?.cancel(reason);
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

function eventStream(event: string, data: unknown): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
      );
      controller.close();
    },
  });
}
