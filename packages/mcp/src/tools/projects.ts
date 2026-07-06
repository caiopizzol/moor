import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  isJsonObject,
  type Project,
  validateGithubRepoUrl,
  validateGithubUrl,
} from "../../../contract/src/index";
import type { ToolContext } from "./context";
export function registerProjectTools(server: McpServer, client: ToolContext): void {
  const { apiResponse, resolveProject, readErrorMessage, readSSE } = client;

  server.registerTool(
    "moor_status",
    {
      title: "List Projects",
      description:
        "List all projects managed by Moor. `status` is moor's recorded state (only changes on explicit start/stop/build/cancel). `live_status` is Docker's view at last successful inspect; differences (e.g. recorded='running' live='error') mean moor missed an external change like a host docker stop, crash, or OOM kill. `live_error` non-null means the most recent inspect failed and the live_* values are the last successful snapshot, not necessarily current.",
    },
    async () => {
      const res = await apiResponse.get("/api/projects");
      if (!res.ok) throw new Error(`Failed: ${res.status}`);
      const projects = (await res.json()) as Project[];
      const summary = projects.map((p) => ({
        name: p.name,
        status: p.status,
        live_status: p.live_status ?? null,
        live_exit_code: p.live_exit_code ?? null,
        live_checked_at: p.live_checked_at ?? null,
        live_error: p.live_error ?? null,
        source: p.docker_image || p.github_url || null,
        domain: p.domain,
      }));
      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    },
  );

  server.registerTool(
    "moor_project_get",
    {
      title: "Get Project",
      description:
        "Returns the full record for a project (source, branch, dockerfile, domain, status, container id, restart policy).",
      inputSchema: z.object({
        project: z.string().describe("Project name or ID"),
      }),
    },
    async ({ project }) => {
      const p = await resolveProject(project);
      return { content: [{ type: "text", text: JSON.stringify(p, null, 2) }] };
    },
  );

  server.registerTool(
    "moor_project_create",
    {
      title: "Create Project",
      description:
        "Creates a new project. Provide exactly one of github_url or docker_image. Does not build or start; call moor_rebuild to bring it up, or use moor_deploy to create and start in one step.",
      inputSchema: z.object({
        name: z
          .string()
          .regex(
            /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/,
            "name must start with an alphanumeric character; allowed chars: a-z, A-Z, 0-9, _, -",
          )
          .describe("Project name (used as the container name suffix: moor-<name>)"),
        github_url: z
          .string()
          .optional()
          .describe("github.com URL; mutually exclusive with docker_image"),
        docker_image: z
          .string()
          .optional()
          .describe(
            "Docker image reference (e.g. nginx:latest); mutually exclusive with github_url",
          ),
        branch: z
          .string()
          .optional()
          .describe("Git branch (default: main, for github_url projects)"),
        dockerfile: z
          .string()
          .optional()
          .describe("Dockerfile path within the repo (default: Dockerfile)"),
        domain: z
          .string()
          .optional()
          .describe("Public domain to route to this container via Caddy"),
        domain_port: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Container port Caddy should forward to (required if domain is set)"),
        restart_policy: z
          .enum(["no", "on-failure", "always", "unless-stopped"])
          .optional()
          .describe("Docker restart policy (default: unless-stopped)"),
        memory_limit_mb: z
          .number()
          .int()
          .min(6)
          .optional()
          .describe(
            "Max RAM in MB (also caps swap to the same value so the container can't burn through host swap). Min 6 (Docker's floor), max host total memory. Omit for unbounded. Takes effect on container recreate (next moor_rebuild / moor_restart / moor_deploy / moor_project run).",
          ),
        cpus: z
          .number()
          .min(0.001)
          .optional()
          .describe(
            "Max CPU cores. Fractional values OK (e.g. 0.5 = half a core). Min 0.001 (anything smaller rounds to Docker NanoCpus=0, which means unlimited — use omit for that). Max host core count. Takes effect on container recreate.",
          ),
        volumes: z
          .array(
            z.object({
              name: z.string().min(1).describe("Logical volume name (unique per project)"),
              target: z
                .string()
                .min(1)
                .describe("Absolute in-container mount path (e.g. /var/lib/postgresql/data)"),
            }),
          )
          .optional()
          .describe(
            "Named Docker volumes to attach. Each entry creates a per-project volume (stored as moor-<project>-<name>) and mounts it at the given target on next container recreate. Data survives container/project rebuilds unless explicitly purged via project delete with purge_volumes=true.",
          ),
        source_credential_id: z
          .number()
          .int()
          .positive()
          .nullable()
          .optional()
          .describe(
            "For github_url projects: pin the source credential row (from moor_source_credential_add) the build path should use. Build synthesizes the credentialed clone URL in memory; the secret is never stored on the project. Ignored when docker_image is set; save-time validation is structural only (id exists).",
          ),
        command: z
          .array(z.string())
          .nullable()
          .optional()
          .describe(
            'Override the image\'s default command (Docker Cmd) as an argv array, e.g. ["tunnel","run"]. Lets a stock image run a custom command with no throwaway Dockerfile. Omit to keep the image default; pass [] or null to clear a previously-set override. Applies on container recreate.',
          ),
        entrypoint: z
          .array(z.string())
          .nullable()
          .optional()
          .describe(
            "Override the image's ENTRYPOINT as an argv array. Omit to keep the image default; pass [] or null to clear. Applies on container recreate.",
          ),
      }),
    },
    async (input) => {
      const sources = (input.github_url ? 1 : 0) + (input.docker_image ? 1 : 0);
      if (sources !== 1) {
        throw new Error("Provide exactly one of github_url or docker_image");
      }
      if (input.github_url) validateGithubUrl(input.github_url);

      const { volumes, ...createBody } = input;
      const res = await apiResponse.post("/api/projects", createBody);
      if (!res.ok) throw new Error(`Failed to create project: ${await readErrorMessage(res)}`);
      const project = (await res.json()) as { id: number };

      // Volumes are a separate endpoint so the API stays single-concern. Loop
      // through them; if any one fails, report what landed and what didn't.
      const volumeFailures: Array<{ name: string; error: string }> = [];
      const volumeCreated: string[] = [];
      if (volumes && volumes.length > 0) {
        for (const v of volumes) {
          const vRes = await apiResponse.post(`/api/projects/${project.id}/volumes`, v);
          if (vRes.ok) volumeCreated.push(v.name);
          else volumeFailures.push({ name: v.name, error: await readErrorMessage(vRes) });
        }
      }

      const lines = [JSON.stringify(project, null, 2)];
      if (volumeCreated.length > 0) {
        lines.push(`\nCreated volumes: ${volumeCreated.join(", ")}`);
      }
      if (volumeFailures.length > 0) {
        lines.push(
          `\nVolume failures (project was still created): ${volumeFailures
            .map((f) => `${f.name}: ${f.error}`)
            .join("; ")}`,
        );
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  server.registerTool(
    "moor_project_update",
    {
      title: "Update Project",
      description:
        "Updates project metadata. Does NOT rebuild or restart the container. Domain or domain_port changes apply to Caddy immediately. Resource-limit changes (memory_limit_mb, cpus) take effect on the next container recreate (moor_rebuild / moor_restart / moor_deploy / moor_project run) — an already-running container keeps its existing limits.",
      inputSchema: z.object({
        project: z.string().describe("Project name or ID to update"),
        name: z
          .string()
          .regex(
            /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/,
            "name must start alphanumeric; allowed: a-z A-Z 0-9 _ -",
          )
          .optional(),
        github_url: z.string().optional(),
        docker_image: z.string().optional(),
        branch: z.string().optional(),
        dockerfile: z.string().optional(),
        domain: z.string().optional(),
        domain_port: z.number().int().positive().optional(),
        restart_policy: z.enum(["no", "on-failure", "always", "unless-stopped"]).optional(),
        memory_limit_mb: z
          .number()
          .int()
          .min(6)
          .nullable()
          .optional()
          .describe(
            "Max RAM in MB. Pass null to clear (return to unbounded). Min 6, max host total memory. Takes effect on container recreate.",
          ),
        cpus: z
          .number()
          .min(0.001)
          .nullable()
          .optional()
          .describe(
            "Max CPU cores (fractional OK; min 0.001). Pass null to clear. Max host core count. Takes effect on container recreate.",
          ),
        source_credential_id: z
          .number()
          .int()
          .positive()
          .nullable()
          .optional()
          .describe(
            "Pin (or unlink, by passing null) the source credential the build path should use for this github_url project. Switching to docker_image force-clears the id regardless of input. Save-time validation is structural only; host-mismatch / not-active is enforced at build time.",
          ),
        command: z
          .array(z.string())
          .nullable()
          .optional()
          .describe(
            'Override the image\'s default command (Docker Cmd) as an argv array, e.g. ["tunnel","run"]. Pass [] or null to clear the override and return to the image default. Takes effect on container recreate.',
          ),
        entrypoint: z
          .array(z.string())
          .nullable()
          .optional()
          .describe(
            "Override the image's ENTRYPOINT as an argv array. Pass [] or null to clear. Takes effect on container recreate.",
          ),
      }),
    },
    async (input) => {
      const { project, ...updates } = input;
      if (Object.keys(updates).length === 0) {
        throw new Error("Provide at least one field to update");
      }
      if (updates.github_url && updates.docker_image) {
        throw new Error("Cannot set both github_url and docker_image in the same update");
      }
      if (updates.github_url) validateGithubUrl(updates.github_url);

      const p = await resolveProject(project);
      const res = await apiResponse.put(`/api/projects/${p.id}`, updates);
      if (!res.ok) throw new Error(`Failed to update project: ${await readErrorMessage(res)}`);
      const updated = await res.json();
      return { content: [{ type: "text", text: JSON.stringify(updated, null, 2) }] };
    },
  );

  server.registerTool(
    "moor_project_delete",
    {
      title: "Delete Project",
      description:
        "Stops and removes the container, then deletes the project record. Requires confirm_name to match the resolved project name exactly. Irreversible. Named Docker volumes are preserved by default (data survives so a recreated project can remount them); pass purge_volumes: true to also delete the underlying Docker volumes — that deletion is also irreversible.",
      inputSchema: z.object({
        project: z.string().describe("Project name or ID to delete"),
        confirm_name: z
          .string()
          .describe(
            "Must equal the resolved project's name. Guards against deleting the wrong project.",
          ),
        purge_volumes: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Also delete the underlying Docker volumes (their data). Default false: project gone, volumes (and their data) preserved. The volume metadata is cleaned up either way; this flag only controls whether the data goes too.",
          ),
      }),
    },
    async ({ project, confirm_name, purge_volumes }) => {
      const p = await resolveProject(project);
      if (confirm_name !== p.name) {
        throw new Error(
          `confirm_name "${confirm_name}" does not match resolved project name "${p.name}". Refusing to delete.`,
        );
      }
      const qs = purge_volumes ? "?purge_volumes=true" : "";
      const res = await apiResponse.delete(`/api/projects/${p.id}${qs}`);
      if (!res.ok) {
        const text = await readErrorMessage(res);
        let message = text;
        try {
          const parsed = JSON.parse(text) as unknown;
          if (isJsonObject(parsed) && typeof parsed.message === "string") {
            message = parsed.message;
          }
        } catch {
          // not json
        }
        throw new Error(`Failed to delete project: ${message}`);
      }
      // 204 No Content (no purge or no volumes) vs 200 JSON (purge with results)
      if (res.status === 204) {
        return { content: [{ type: "text", text: `Deleted project ${p.name} (id=${p.id}).` }] };
      }
      const body = (await res.json()) as { volumes_purged?: number };
      return {
        content: [
          {
            type: "text",
            text: `Deleted project ${p.name} (id=${p.id}). Purged ${body.volumes_purged ?? 0} Docker volume(s).`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "moor_deploy",
    {
      title: "Deploy Project",
      description:
        "Create-or-update a project end to end: metadata, env vars (merged into existing), and an optional build/run. Default fails if the project already exists; pass update_existing: true to upsert. When run: true (default), waits for the full Docker build/pull and start, which can take minutes for large images. Errors are tagged by the failing step ([create], [update], [set_env], or [run]) and do not roll back earlier steps.",
      inputSchema: z.object({
        name: z
          .string()
          .regex(
            /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/,
            "name must start alphanumeric; allowed chars: a-z A-Z 0-9 _ -",
          )
          .describe("Project name (also the container suffix: moor-<name>)"),
        github_url: z
          .string()
          .optional()
          .describe(
            "GitHub repo URL: host must be github.com or www.github.com, path must be /owner/repo (optional .git). Mutually exclusive with docker_image.",
          ),
        docker_image: z
          .string()
          .optional()
          .describe(
            "Docker image reference (e.g. nginx:latest). Mutually exclusive with github_url.",
          ),
        branch: z.string().optional().describe("Git branch (API default: main)"),
        dockerfile: z
          .string()
          .optional()
          .describe("Dockerfile path in the repo (API default: Dockerfile)"),
        domain: z.string().optional().describe("Public domain to route via Caddy"),
        domain_port: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Container port Caddy should forward to"),
        restart_policy: z
          .enum(["no", "on-failure", "always", "unless-stopped"])
          .optional()
          .describe("Docker restart policy (API default: unless-stopped)"),
        memory_limit_mb: z
          .number()
          .int()
          .min(6)
          .nullable()
          .optional()
          .describe(
            "Max RAM in MB (also caps swap to the same value). Min 6, max host total memory. Pass null on update to clear. Limits apply on container recreate, which deploy always does when run: true.",
          ),
        cpus: z
          .number()
          .min(0.001)
          .nullable()
          .optional()
          .describe(
            "Max CPU cores. Fractional OK (e.g. 0.5; min 0.001). Max host core count. Pass null on update to clear.",
          ),
        volumes: z
          .array(
            z.object({
              name: z.string().min(1),
              target: z.string().min(1),
            }),
          )
          .optional()
          .describe(
            "Named Docker volumes to attach. Each entry becomes a per-project volume (stored as moor-<project>-<name>) and mounts at the given target on container recreate. On update_existing, additions only — no removals. Data survives container/project rebuilds unless explicitly purged via moor_project_delete with confirm_name (purge_volumes is a separate flag).",
          ),
        env: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            "Env vars to MERGE into existing project envs. Omit to leave envs untouched. Pass {} for an explicit no-op. Use moor_env_delete to remove keys.",
          ),
        source_credential_id: z
          .number()
          .int()
          .positive()
          .nullable()
          .optional()
          .describe(
            "For github_url projects: pin the source credential row (created via moor_source_credential_add). Build path synthesizes the credentialed clone URL in memory; secret never gets stored on the project row. Pass null to detach without switching source type. Ignored when docker_image is set. Save-time validation is structural only (id exists); host-mismatch / not-active is enforced at build time so configuration can survive transient credential outages.",
          ),
        command: z
          .array(z.string())
          .nullable()
          .optional()
          .describe(
            'Override the image default command (Docker Cmd) as an argv array, e.g. ["tunnel","run"]. Lets a stock image (e.g. cloudflare/cloudflared) run a custom command with no throwaway Dockerfile. Omit to keep the image default; pass [] or null to clear. Applies on the recreate the run step performs.',
          ),
        entrypoint: z
          .array(z.string())
          .nullable()
          .optional()
          .describe(
            "Override the image ENTRYPOINT as an argv array. Omit to keep the image default; pass [] or null to clear. Applies on container recreate.",
          ),
        files: z
          .array(
            z.object({
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
                  "Name of a project env var to source the contents from at create time, so a secret (TLS key, token) lives in the env store rather than in plaintext here. Provide exactly one of content or env_ref.",
                ),
              mode: z
                .string()
                .optional()
                .describe(
                  "Octal permission string for the tar header, e.g. '0600'. Default '0644'.",
                ),
            }),
          )
          .optional()
          .describe(
            "Declarative files to inject into the container before it starts, written on every recreate (additions/updates only — moor_deploy never removes files; use moor_file_remove). Each file's path identifies it; re-deploying the same path updates its content. Honors the octal mode in the tar header (e.g. 0600 for a key).",
          ),
        run: z
          .boolean()
          .optional()
          .default(true)
          .describe(
            "Build/pull and start after create/update. Default true. Setting false leaves the container untouched; if envs changed while the container is running, the change will not apply until the next run/restart.",
          ),
        update_existing: z
          .boolean()
          .optional()
          .default(false)
          .describe("Allow updating a project that already exists. Default false (create-only)."),
      }),
    },
    async (input) => {
      // Up-front validation: do strict checks before any side effects.
      if (input.github_url) validateGithubRepoUrl(input.github_url);
      if (input.github_url && input.docker_image) {
        throw new Error("Cannot set both github_url and docker_image");
      }

      // #79: drain-mode preflight. moor_deploy is a composition: by the
      // time the run step (Step 3) hits the drain 503 from /api/projects/
      // :id/run, the create/update/volume/env side effects have already
      // landed. Check drain server-side BEFORE any writes so a drained
      // deploy fails cleanly without leaving partial state.
      //
      // Skipped when run: false because the no-run mode is metadata-only —
      // no container work, so drain doesn't apply.
      if (input.run !== false) {
        const drainRes = await apiResponse.get("/api/server/drain");
        if (drainRes.ok) {
          const { state } = (await drainRes.json()) as {
            state: { enabled: boolean; reason: string | null; expires_at: string | null };
          };
          if (state.enabled) {
            throw new Error(
              `[drain] moor is draining (reason: ${state.reason ?? "(none)"}; expires_at: ${state.expires_at}). Refusing deploy before any project create/update side effects. Use moor_drain_disable to re-enable, or retry after expiry. Pass run: false if you only need metadata changes.`,
            );
          }
        }
        // If the drain endpoint is unreachable (older moor or transient
        // failure), don't block the deploy — the per-route gate inside
        // /api/projects/:id/run will still catch it before container work
        // starts. Preflight is an optimization, not the guarantee.
      }

      // Resolve existence and check domain conflicts from a single project list.
      const listRes = await apiResponse.get("/api/projects");
      if (!listRes.ok) throw new Error(`Failed to list projects: ${listRes.status}`);
      const projects = (await listRes.json()) as Project[];
      const existing = projects.find((p) => p.name === input.name);

      if (existing && !input.update_existing) {
        throw new Error(
          `Project "${input.name}" already exists. Pass update_existing: true to update it.`,
        );
      }

      if (!existing) {
        const sources = (input.github_url ? 1 : 0) + (input.docker_image ? 1 : 0);
        if (sources !== 1) {
          throw new Error("Provide exactly one of github_url or docker_image");
        }
      }

      // Normalize once for both the conflict check and the write. The API trims but
      // does not lowercase, so " Example.com " vs an existing "example.com" would
      // slip past the raw-string pre-check and only surface as a Caddy collision.
      const normalizedDomain =
        input.domain === undefined ? undefined : input.domain.trim().toLowerCase() || null;

      if (normalizedDomain) {
        const conflict = projects.find(
          (p) =>
            p.domain && p.domain.trim().toLowerCase() === normalizedDomain && p.id !== existing?.id,
        );
        if (conflict) {
          throw new Error(
            `Domain "${normalizedDomain}" is already used by project "${conflict.name}" (id=${conflict.id}). Refusing before Caddy reload.`,
          );
        }
      }

      // Step 1: create or update project metadata.
      let projectId: number;
      let projectName: string;
      if (!existing) {
        const createBody: Record<string, unknown> = {
          name: input.name,
          github_url: input.github_url,
          docker_image: input.docker_image,
          branch: input.branch,
          dockerfile: input.dockerfile,
          domain: normalizedDomain,
          domain_port: input.domain_port,
          restart_policy: input.restart_policy,
          memory_limit_mb: input.memory_limit_mb,
          cpus: input.cpus,
          source_credential_id: input.source_credential_id,
          command: input.command,
          entrypoint: input.entrypoint,
        };
        const res = await apiResponse.post("/api/projects", createBody);
        if (!res.ok) throw new Error(`[create] ${await readErrorMessage(res)}`);
        const created = (await res.json()) as Project;
        projectId = created.id;
        projectName = created.name;
      } else {
        // Update only fields explicitly provided. `name` is the lookup key here,
        // not a rename target; use moor_project_update for renames.
        const updateBody: Record<string, unknown> = {};
        if (input.github_url !== undefined) updateBody.github_url = input.github_url;
        if (input.docker_image !== undefined) updateBody.docker_image = input.docker_image;
        if (input.branch !== undefined) updateBody.branch = input.branch;
        if (input.dockerfile !== undefined) updateBody.dockerfile = input.dockerfile;
        if (normalizedDomain !== undefined) updateBody.domain = normalizedDomain;
        if (input.domain_port !== undefined) updateBody.domain_port = input.domain_port;
        if (input.restart_policy !== undefined) updateBody.restart_policy = input.restart_policy;
        if (input.memory_limit_mb !== undefined) updateBody.memory_limit_mb = input.memory_limit_mb;
        if (input.cpus !== undefined) updateBody.cpus = input.cpus;
        if (input.source_credential_id !== undefined)
          updateBody.source_credential_id = input.source_credential_id;
        if (input.command !== undefined) updateBody.command = input.command;
        if (input.entrypoint !== undefined) updateBody.entrypoint = input.entrypoint;

        if (Object.keys(updateBody).length > 0) {
          const res = await apiResponse.put(`/api/projects/${existing.id}`, updateBody);
          if (!res.ok) throw new Error(`[update] ${await readErrorMessage(res)}`);
        }
        projectId = existing.id;
        projectName = existing.name;
      }

      // Step 1.5: add named volumes (additions only — moor_deploy never removes
      // volumes, even on update_existing). Mounts apply on next container
      // recreate, which the run step below triggers by default.
      if (input.volumes && input.volumes.length > 0) {
        // Cache the existing list once so we can resolve 409s without re-fetching
        // per conflict. Only fetched if a 409 actually occurs.
        let existingVolumes: Array<{ name: string; target: string }> | null = null;
        for (const v of input.volumes) {
          const vRes = await apiResponse.post(`/api/projects/${projectId}/volumes`, v);
          if (vRes.ok) continue;
          const text = await readErrorMessage(vRes);
          if (vRes.status !== 409) {
            throw new Error(`[volumes] failed to add ${v.name}: ${text}`);
          }
          // 409 is tolerable ONLY if the existing volume matches the requested
          // spec exactly (same name, same target). A 409 with a drifted target
          // means the operator changed the desired mount and we'd silently
          // ignore the change — fail loudly instead.
          if (existingVolumes === null) {
            const listRes = await apiResponse.get(`/api/projects/${projectId}/volumes`);
            if (!listRes.ok) {
              throw new Error(
                `[volumes] could not resolve 409 on ${v.name}: failed to list existing volumes: ${await readErrorMessage(listRes)}`,
              );
            }
            existingVolumes = (await listRes.json()) as Array<{ name: string; target: string }>;
          }
          const match = existingVolumes.find((e) => e.name === v.name);
          if (!match) {
            // 409 was for some other reason (target collision under a different
            // name, or cross-project docker_name collision). Operator must
            // intervene.
            throw new Error(
              `[volumes] conflict adding ${v.name}: ${text} (no existing volume by that name; check for target collision)`,
            );
          }
          if (match.target !== v.target) {
            throw new Error(
              `[volumes] conflict adding ${v.name}: existing target "${match.target}" differs from requested "${v.target}". moor_deploy does not change mount targets; use moor_volume_remove + moor_volume_add explicitly.`,
            );
          }
          // Same name, same target — idempotent re-run, tolerable.
        }
      }

      // Step 1.6: inject declarative files (additions/updates only — deploy never
      // removes files; use moor_file_remove for that). The route upserts by path,
      // so re-deploying the same path updates its content. Files are written into
      // the container right before start on the recreate the run step triggers.
      if (input.files && input.files.length > 0) {
        for (const f of input.files) {
          const fRes = await apiResponse.post(`/api/projects/${projectId}/files`, f);
          if (!fRes.ok) {
            throw new Error(`[files] failed to set ${f.path}: ${await readErrorMessage(fRes)}`);
          }
        }
      }

      // Step 2: merge envs. Omitted env leaves existing untouched; {} is a no-op.
      const envEntries = input.env ? Object.entries(input.env) : [];
      const envProvided = envEntries.length > 0;
      if (envProvided) {
        const existingRes = await apiResponse.get(`/api/projects/${projectId}/envs`);
        if (!existingRes.ok) {
          throw new Error(`[set_env] Failed to read envs: ${existingRes.status}`);
        }
        const existingEnvs = (await existingRes.json()) as { key: string; value: string }[];
        const merged = new Map(existingEnvs.map((v) => [v.key, v.value]));
        for (const [k, v] of envEntries) merged.set(k, v);
        const allVars = Array.from(merged, ([key, value]) => ({ key, value }));
        const putRes = await apiResponse.put(`/api/projects/${projectId}/envs`, allVars);
        if (!putRes.ok) throw new Error(`[set_env] ${await readErrorMessage(putRes)}`);
      }

      // Step 3: run, default true. Wait for the full SSE stream like moor_rebuild.
      let runLogs = "";
      let runStructuredError: { code: string; message: string } | undefined;
      if (input.run) {
        const runRes = await apiResponse.post(`/api/projects/${projectId}/run`);
        if (!runRes.ok) throw new Error(`[run] ${await readErrorMessage(runRes)}`);
        const { logs, error, structuredError } = await readSSE(runRes);
        runLogs = logs;
        // #119: classified failure (today: source_credential_required) is
        // returned as isError below so the agent can branch on the code
        // instead of parsing a thrown message.
        if (structuredError) {
          runStructuredError = structuredError;
        } else if (error) {
          throw new Error(`[run] ${error}`);
        }
      }

      const lines: string[] = [];
      lines.push(
        existing
          ? `Updated project ${projectName} (id=${projectId}).`
          : `Created project ${projectName} (id=${projectId}).`,
      );
      if (envProvided) {
        lines.push(
          `Merged ${envEntries.length} env var(s): ${envEntries.map(([k]) => k).join(", ")}.`,
        );
      }
      if (!input.run) {
        if (envProvided && existing?.status === "running") {
          lines.push(
            "Note: project is running; env changes will not take effect until the next run or restart.",
          );
        }
      } else {
        lines.push("");
        lines.push("Build/run output:");
        lines.push(runLogs || "(no output)");
      }
      // #119: if the build was classified as auth-failure, return isError
      // with the structured payload so the agent can call _check + add a
      // credential and retry. The project row exists (create/update already
      // committed) so the agent just needs to fix the credential and run
      // deploy again with the pinned id.
      if (runStructuredError) {
        lines.push("");
        lines.push(`Failed: code=${runStructuredError.code} message=${runStructuredError.message}`);
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          structuredContent: { ...runStructuredError, project_id: projectId },
          isError: true,
        };
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );
}
