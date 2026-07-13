import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  CRON_TIMEOUT_MAX_MS,
  CRON_TIMEOUT_MIN_MS,
  isJsonObject,
  validateCronSchedule,
} from "../../../contract/src/index";
import type { ToolContext } from "./context";
export function registerEnvTools(server: McpServer, client: ToolContext): void {
  const { apiResponse, resolveProject, readErrorMessage } = client;

  server.registerTool(
    "moor_env_list",
    {
      title: "List Environment Variables",
      description: "List all environment variables set for a project.",
      inputSchema: z.object({
        project: z.string().describe("Project name or ID"),
      }),
    },
    async ({ project }) => {
      const p = await resolveProject(project);
      const res = await apiResponse.get(`/api/projects/${p.id}/envs`);
      if (!res.ok) throw new Error(`Failed: ${res.status}`);
      const vars = (await res.json()) as { key: string; value: string }[];
      if (vars.length === 0)
        return { content: [{ type: "text", text: "No environment variables set." }] };
      const text = vars.map((v) => `${v.key}=${v.value}`).join("\n");
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "moor_env_set",
    {
      title: "Set Environment Variables",
      description:
        "Set environment variables for a project. Merges with existing vars. Automatically restarts the container if running.",
      inputSchema: z.object({
        project: z.string().describe("Project name or ID"),
        vars: z
          .record(z.string(), z.string())
          .describe('Key-value pairs to set, e.g. { "DATABASE_URL": "postgres://..." }'),
      }),
    },
    async ({ project, vars }) => {
      const p = await resolveProject(project);

      // Fetch existing and merge
      const existingRes = await apiResponse.get(`/api/projects/${p.id}/envs`);
      if (!existingRes.ok) throw new Error(`Failed to get envs: ${existingRes.status}`);
      const existing = (await existingRes.json()) as { key: string; value: string }[];
      const merged = new Map(existing.map((v) => [v.key, v.value]));
      for (const [key, value] of Object.entries(vars)) {
        merged.set(key, value);
      }
      const allVars = Array.from(merged, ([key, value]) => ({ key, value }));

      const setRes = await apiResponse.put(`/api/projects/${p.id}/envs`, allVars);
      if (!setRes.ok) throw new Error(`Failed to set envs: ${await readErrorMessage(setRes)}`);

      const keys = Object.keys(vars).join(", ");
      let text = `Set ${keys} on ${p.name}.`;

      // Restart if running
      if (p.status === "running") {
        await apiResponse.post(`/api/projects/${p.id}/stop`);
        const startRes = await apiResponse.post(`/api/projects/${p.id}/start`);
        if (!startRes.ok)
          throw new Error(`Set vars but failed to restart: ${await readErrorMessage(startRes)}`);
        text += " Container restarted.";
      }

      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "moor_cron_create",
    {
      title: "Create Cron",
      description:
        "Creates a cron schedule on a project. Schedule is a 5-field crontab string with numeric values only (no jan/sun/etc.). Day-of-week uses 0=Sunday through 6=Saturday; 7 is not accepted. timeout_ms defaults to 10 minutes and supports up to 7 days.",
      inputSchema: z.object({
        project: z.string().describe("Project name or ID"),
        name: z.string().min(1).describe("Human-readable name for the cron"),
        schedule: z.string().describe('5-field crontab, e.g. "0 3 * * *" for 03:00 daily'),
        command: z.string().min(1).describe("Shell command to run inside the project's container"),
        timeout_ms: z
          .number()
          .int()
          .min(CRON_TIMEOUT_MIN_MS)
          .max(CRON_TIMEOUT_MAX_MS)
          .optional()
          .describe("Maximum run time in milliseconds. Defaults to 10 minutes; maximum is 7 days."),
      }),
    },
    async ({ project, name, schedule, command, timeout_ms }) => {
      const err = validateCronSchedule(schedule);
      if (err) throw new Error(`Invalid schedule: ${err}`);
      const p = await resolveProject(project);
      const res = await apiResponse.post(`/api/projects/${p.id}/crons`, {
        name,
        schedule,
        command,
        ...(timeout_ms === undefined ? {} : { timeout_ms }),
      });
      if (!res.ok) throw new Error(`Failed to create cron: ${await readErrorMessage(res)}`);
      const cron = await res.json();
      return { content: [{ type: "text", text: JSON.stringify(cron, null, 2) }] };
    },
  );

  server.registerTool(
    "moor_cron_update",
    {
      title: "Update Cron",
      description:
        "Updates a cron's fields by id, including timeout_ms. Schedule and timeout are validated if provided.",
      inputSchema: z.object({
        cron_id: z.number().int().positive().describe("Cron ID"),
        name: z.string().min(1).optional(),
        schedule: z.string().optional(),
        command: z.string().min(1).optional(),
        timeout_ms: z.number().int().min(CRON_TIMEOUT_MIN_MS).max(CRON_TIMEOUT_MAX_MS).optional(),
        enabled: z.boolean().optional().describe("Enable or disable the cron"),
      }),
    },
    async ({ cron_id, name, schedule, command, timeout_ms, enabled }) => {
      if (schedule !== undefined) {
        const err = validateCronSchedule(schedule);
        if (err) throw new Error(`Invalid schedule: ${err}`);
      }
      const body: Record<string, unknown> = {};
      if (name !== undefined) body.name = name;
      if (schedule !== undefined) body.schedule = schedule;
      if (command !== undefined) body.command = command;
      if (timeout_ms !== undefined) body.timeout_ms = timeout_ms;
      if (enabled !== undefined) body.enabled = enabled ? 1 : 0;
      if (Object.keys(body).length === 0) {
        throw new Error("Provide at least one field to update");
      }
      const res = await apiResponse.put(`/api/crons/${cron_id}`, body);
      if (!res.ok) throw new Error(`Failed to update cron: ${await readErrorMessage(res)}`);
      const cron = await res.json();
      return { content: [{ type: "text", text: JSON.stringify(cron, null, 2) }] };
    },
  );

  server.registerTool(
    "moor_cron_delete",
    {
      title: "Delete Cron",
      description: "Deletes a cron by id.",
      inputSchema: z.object({
        cron_id: z.number().int().positive().describe("Cron ID"),
      }),
    },
    async ({ cron_id }) => {
      const res = await apiResponse.delete(`/api/crons/${cron_id}`);
      if (!res.ok) throw new Error(`Failed to delete cron: ${await readErrorMessage(res)}`);
      // API returns 204 whether or not the row existed; phrase the response so it
      // doesn't claim a row was removed when it might already have been gone.
      return { content: [{ type: "text", text: `Deletion requested for cron ${cron_id}.` }] };
    },
  );

  server.registerTool(
    "moor_cron_run",
    {
      title: "Run Cron Now",
      description:
        "Triggers a cron to run immediately. Requires the project's container to be running.",
      inputSchema: z.object({
        cron_id: z.number().int().positive().describe("Cron ID"),
      }),
    },
    async ({ cron_id }) => {
      const res = await apiResponse.post(`/api/crons/${cron_id}/run`);
      if (!res.ok) {
        const text = await readErrorMessage(res);
        let message = text;
        try {
          const parsed = JSON.parse(text) as unknown;
          if (isJsonObject(parsed) && typeof parsed.error === "string") message = parsed.error;
        } catch {
          // Not JSON; use raw text
        }
        throw new Error(message);
      }
      return { content: [{ type: "text", text: `Triggered cron ${cron_id}.` }] };
    },
  );

  server.registerTool(
    "moor_env_delete",
    {
      title: "Delete Environment Variables",
      description:
        "Removes one or more environment variables from a project. Restarts the container only if at least one key was actually deleted AND the project was running.",
      inputSchema: z.object({
        project: z.string().describe("Project name or ID"),
        keys: z.array(z.string().min(1)).min(1).describe("Env var keys to remove"),
      }),
    },
    async ({ project, keys }) => {
      const p = await resolveProject(project);

      const existingRes = await apiResponse.get(`/api/projects/${p.id}/envs`);
      if (!existingRes.ok) throw new Error(`Failed to get envs: ${existingRes.status}`);
      const existing = (await existingRes.json()) as { key: string; value: string }[];
      const existingKeys = new Set(existing.map((v) => v.key));

      const toDelete = keys.filter((k) => existingKeys.has(k));
      const missing = keys.filter((k) => !existingKeys.has(k));

      if (toDelete.length === 0) {
        const existingList = [...existingKeys].sort().join(", ") || "(none)";
        return {
          content: [
            {
              type: "text",
              text: `No matching keys on ${p.name}. Existing keys: ${existingList}`,
            },
          ],
        };
      }

      for (const key of toDelete) {
        const res = await apiResponse.delete(
          `/api/projects/${p.id}/envs/${encodeURIComponent(key)}`,
        );
        if (!res.ok) throw new Error(`Failed to delete ${key}: ${await readErrorMessage(res)}`);
      }

      let text = `Deleted ${toDelete.join(", ")} from ${p.name}.`;
      if (missing.length > 0) text += ` (Not present: ${missing.join(", ")}.)`;

      if (p.status === "running") {
        await apiResponse.post(`/api/projects/${p.id}/stop`);
        const startRes = await apiResponse.post(`/api/projects/${p.id}/start`);
        if (!startRes.ok) {
          throw new Error(
            `Deleted vars but failed to restart: ${await readErrorMessage(startRes)}`,
          );
        }
        text += " Container restarted.";
      }

      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "moor_volume_list",
    {
      title: "List Project Volumes",
      description:
        "List the named Docker volumes attached to a project. Each entry includes the logical name (per-project handle), the in-container target path, and the actual Docker volume name (for `docker volume ls` / `docker volume inspect` outside moor).",
      inputSchema: z.object({
        project: z.string().describe("Project name or ID"),
      }),
    },
    async ({ project }) => {
      const p = await resolveProject(project);
      const res = await apiResponse.get(`/api/projects/${p.id}/volumes`);
      if (!res.ok) throw new Error(`Failed: ${await readErrorMessage(res)}`);
      const rows = (await res.json()) as Array<{
        id: number;
        name: string;
        target: string;
        docker_name: string;
      }>;
      if (rows.length === 0) {
        return { content: [{ type: "text", text: `No volumes attached to ${p.name}.` }] };
      }
      const lines = rows.map(
        (v) => `id=${v.id}  name=${v.name}  target=${v.target}  docker_name=${v.docker_name}`,
      );
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  server.registerTool(
    "moor_volume_add",
    {
      title: "Add Project Volume",
      description:
        "Attach a named Docker volume to a project. The volume is created lazily by Docker on first container start; moor stores the mount config (logical name, in-container target, and the generated docker_name like moor-<project>-<name>). Takes effect on container recreate (next moor_rebuild / moor_restart / moor_deploy / moor_project run) — already-running containers keep their existing mounts.",
      inputSchema: z.object({
        project: z.string().describe("Project name or ID"),
        name: z
          .string()
          .min(1)
          .describe("Logical volume name (unique per project; alphanumeric/_/-)"),
        target: z
          .string()
          .min(1)
          .describe("Absolute in-container mount path (e.g. /var/lib/postgresql/data)"),
      }),
    },
    async ({ project, name, target }) => {
      const p = await resolveProject(project);
      const res = await apiResponse.post(`/api/projects/${p.id}/volumes`, { name, target });
      if (!res.ok) throw new Error(`Failed: ${await readErrorMessage(res)}`);
      const created = (await res.json()) as {
        id: number;
        name: string;
        target: string;
        docker_name: string;
      };
      return {
        content: [
          {
            type: "text",
            text: `Attached volume to ${p.name}: id=${created.id}, name=${created.name}, target=${created.target}, docker_name=${created.docker_name}. Mount applies on next container recreate.`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "moor_volume_remove",
    {
      title: "Remove Project Volume Mount",
      description:
        "Detach a named volume from a project's mount config. The underlying Docker volume (and its data) is intentionally preserved — to actually delete the data, use moor_project_delete with purge_volumes:true, or run `docker volume rm <docker_name>` manually. Takes effect on next container recreate.",
      inputSchema: z.object({
        project: z.string().describe("Project name or ID"),
        volume_id: z.number().int().positive().describe("Volume ID from moor_volume_list"),
      }),
    },
    async ({ project, volume_id }) => {
      const p = await resolveProject(project);
      const res = await apiResponse.delete(`/api/projects/${p.id}/volumes/${volume_id}`);
      if (res.status === 404) throw new Error(`Volume ${volume_id} not found on project ${p.name}`);
      if (!res.ok) throw new Error(`Failed: ${await readErrorMessage(res)}`);
      const body = (await res.json()) as { docker_name: string; message: string };
      return { content: [{ type: "text", text: body.message }] };
    },
  );

  server.registerTool(
    "moor_file_set",
    {
      title: "Set Project File",
      description:
        "Declare a file to inject into a project's container. moor writes it via a tar archive PUT right before the container starts, on every recreate, honoring the octal mode (e.g. 0600 for a TLS key). Identified by path — setting the same path again updates its content/mode rather than duplicating. Provide exactly one of content (inline) or env_ref (the name of a project env var to source content from at create time, so a secret stays in the env store instead of plaintext here). Takes effect on next container recreate (moor_rebuild / moor_restart / moor_deploy / moor_project run).",
      inputSchema: z.object({
        project: z.string().describe("Project name or ID"),
        path: z
          .string()
          .min(1)
          .describe("Absolute in-container destination path, e.g. /etc/ssl/cert.pem"),
        content: z
          .string()
          .optional()
          .describe("Inline file contents. Provide exactly one of content or env_ref."),
        env_ref: z
          .string()
          .optional()
          .describe(
            "Name of a project env var to source the contents from at create time. Keeps secrets (keys, certs) in the env store instead of plaintext here. Provide exactly one of content or env_ref.",
          ),
        mode: z
          .string()
          .optional()
          .describe(
            "Octal permission string applied in the tar header, e.g. '0600'. Default '0644'.",
          ),
      }),
    },
    async ({ project, path, content, env_ref, mode }) => {
      const p = await resolveProject(project);
      const body: Record<string, unknown> = { path };
      if (content !== undefined) body.content = content;
      if (env_ref !== undefined) body.env_ref = env_ref;
      if (mode !== undefined) body.mode = mode;
      const res = await apiResponse.post(`/api/projects/${p.id}/files`, body);
      if (!res.ok) throw new Error(`Failed: ${await readErrorMessage(res)}`);
      const saved = (await res.json()) as {
        id: number;
        path: string;
        mode: string;
        source: string;
        env_ref: string | null;
      };
      const verb = res.status === 201 ? "Added" : "Updated";
      return {
        content: [
          {
            type: "text",
            text: `${verb} file on ${p.name}: id=${saved.id}, path=${saved.path}, mode=${saved.mode}, source=${saved.source}${saved.env_ref ? ` (env_ref=${saved.env_ref})` : ""}. Written into the container on next recreate.`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "moor_file_list",
    {
      title: "List Project Files",
      description:
        "List the declarative files configured for a project. Each entry shows the in-container path, octal mode, and how content is sourced (inline or env). Raw inline content is never returned (it may be large, and env-sourced content lives in the env store).",
      inputSchema: z.object({
        project: z.string().describe("Project name or ID"),
      }),
    },
    async ({ project }) => {
      const p = await resolveProject(project);
      const res = await apiResponse.get(`/api/projects/${p.id}/files`);
      if (!res.ok) throw new Error(`Failed: ${await readErrorMessage(res)}`);
      const rows = (await res.json()) as Array<{
        id: number;
        path: string;
        mode: string;
        source: string;
        env_ref: string | null;
      }>;
      if (rows.length === 0) {
        return { content: [{ type: "text", text: `No files configured for ${p.name}.` }] };
      }
      const lines = rows.map(
        (f) =>
          `id=${f.id}  path=${f.path}  mode=${f.mode}  source=${f.source}${f.env_ref ? `  env_ref=${f.env_ref}` : ""}`,
      );
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  server.registerTool(
    "moor_file_remove",
    {
      title: "Remove Project File",
      description:
        "Remove a declared file from a project's injection set. The file stops being written on future container recreates; a copy already present in a running container is not deleted until the next recreate. Takes effect on next container recreate.",
      inputSchema: z.object({
        project: z.string().describe("Project name or ID"),
        file_id: z.number().int().positive().describe("File ID from moor_file_list"),
      }),
    },
    async ({ project, file_id }) => {
      const p = await resolveProject(project);
      const res = await apiResponse.delete(`/api/projects/${p.id}/files/${file_id}`);
      if (res.status === 404) throw new Error(`File ${file_id} not found on project ${p.name}`);
      if (!res.ok) throw new Error(`Failed: ${await readErrorMessage(res)}`);
      return {
        content: [
          {
            type: "text",
            text: `Removed file ${file_id} from ${p.name}. Applies on next container recreate.`,
          },
        ],
      };
    },
  );
}
