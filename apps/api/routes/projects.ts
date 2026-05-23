import { syncCaddyRoutes } from "../caddy";
import db from "../db";
import { removeContainer, removeVolume, stopContainer } from "../docker";
import { reconcileGithubUrl, redactCredentials, serializeProject } from "../redact";
import { validateCpus, validateMemoryLimitMb } from "../resource-limits";
import { collectProjectVolumeDockerNames } from "./volumes";

/** Run Caddy sync. On failure, return a 500 with a clear message that the DB write
 *  succeeded but the route is not active, plus the manual recovery command. The
 *  DB state is intentionally preserved: it captures the operator's intent and a
 *  retry will be idempotent. Returns null on success so callers can continue. */
async function applyCaddySync(action: string): Promise<Response | null> {
  try {
    await syncCaddyRoutes();
    return null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(
      `${action} saved, but Caddy route apply failed: ${msg}\n` +
        "Manual recovery: docker compose exec caddy caddy reload --config /app/data/Caddyfile --adapter caddyfile",
      { status: 500 },
    );
  }
}

export async function handleProjects(req: Request, url: URL): Promise<Response | null> {
  const match = url.pathname.match(/^\/api\/projects(?:\/(\d+))?$/);
  if (!match) return null;

  const id = match[1] ? Number(match[1]) : null;
  console.log(`[projects] ${req.method} /api/projects${id ? `/${id}` : ""}`);

  if (req.method === "GET" && !id) {
    const rows = db.query("SELECT * FROM projects ORDER BY name").all() as Array<{
      github_url: string | null;
    }>;
    console.log(`[projects] listing ${rows.length} projects`);
    return Response.json(rows.map(serializeProject));
  }

  if (req.method === "GET" && id) {
    const row = db.query("SELECT * FROM projects WHERE id = ?").get(id) as {
      github_url: string | null;
    } | null;
    if (!row) return new Response("Not found", { status: 404 });
    return Response.json(serializeProject(row));
  }

  if (req.method === "POST" && !id) {
    return await handleCreate(req);
  }

  if (req.method === "PUT" && id) {
    return await handleUpdate(req, id);
  }

  if (req.method === "DELETE" && id) {
    // Stop and remove the container before deleting the project
    const project = db.query("SELECT container_id, domain FROM projects WHERE id = ?").get(id) as {
      container_id: string | null;
      domain: string | null;
    } | null;
    if (project?.container_id) {
      try {
        await stopContainer(project.container_id);
        await removeContainer(project.container_id);
      } catch {
        // best effort — container may already be gone
      }
    }

    // #35: purge_volumes is an explicit destructive opt-in. By default the
    // project's named Docker volumes are preserved (so a recreated project of
    // the same name could remount them, and the operator never loses data to
    // a misclick). Volume docker_names must be collected BEFORE the project
    // row is deleted — the ON DELETE CASCADE wipes project_volumes too.
    const url2 = new URL(req.url);
    const purgeVolumes = url2.searchParams.get("purge_volumes") === "true";
    const volumeNames = purgeVolumes ? collectProjectVolumeDockerNames(id) : [];

    const hadDomain = !!project?.domain;
    db.query("DELETE FROM projects WHERE id = ?").run(id);

    // Both Caddy sync and volume purge attempt UNCONDITIONALLY. We must not
    // return early on Caddy failure if a purge was requested: by this point
    // project_volumes has been CASCADE-wiped, and `volumeNames` is the only
    // remaining handle for the operator to act on. Skipping the purge would
    // leak orphaned volumes that moor can no longer help clean up.
    let caddyFailure: Response | null = null;
    if (hadDomain) {
      caddyFailure = await applyCaddySync("Project deletion");
    }

    const purgeFailures: Array<{ name: string; error: string }> = [];
    if (purgeVolumes && volumeNames.length > 0) {
      for (const name of volumeNames) {
        const result = await removeVolume(name);
        if (!result.ok) purgeFailures.push({ name, error: result.error });
      }
    }

    if (caddyFailure && purgeFailures.length === 0 && !purgeVolumes) {
      return caddyFailure;
    }
    if (caddyFailure || purgeFailures.length > 0) {
      const messages: string[] = [];
      if (caddyFailure) {
        messages.push(`Caddy reload failed (${await caddyFailure.text()})`);
      }
      if (purgeFailures.length > 0) {
        messages.push(
          `${purgeFailures.length} volume(s) failed to purge — remove manually via 'docker volume rm'`,
        );
      }
      return Response.json(
        {
          ok: false,
          project_deleted: true,
          caddy_failed: caddyFailure !== null,
          volumes_purged: purgeVolumes ? volumeNames.length - purgeFailures.length : 0,
          volumes_failed: purgeFailures,
          message: `Project deleted, but: ${messages.join("; ")}`,
        },
        { status: 500 },
      );
    }
    if (purgeVolumes) {
      return Response.json({
        ok: true,
        project_deleted: true,
        volumes_purged: volumeNames.length,
      });
    }
    return new Response(null, { status: 204 });
  }

  return null;
}

async function handleCreate(req: Request): Promise<Response> {
  const body = await req.json();
  const {
    name,
    github_url,
    docker_image,
    branch,
    dockerfile,
    domain,
    domain_port,
    restart_policy,
    memory_limit_mb,
    cpus,
  } = body;
  console.log(
    `[projects] create: name=${name} github_url=${redactCredentials(github_url) ?? ""} docker_image=${docker_image} branch=${branch || "main"} dockerfile=${dockerfile || "Dockerfile"} domain=${domain || ""} domain_port=${domain_port || ""} memory_limit_mb=${memory_limit_mb ?? ""} cpus=${cpus ?? ""}`,
  );
  if (!name) return new Response("name is required", { status: 400 });
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) {
    return new Response("name must be alphanumeric (hyphens and underscores allowed)", {
      status: 400,
    });
  }

  const memErr = validateMemoryLimitMb(memory_limit_mb);
  if (memErr) return new Response(memErr, { status: 400 });
  const cpuErr = validateCpus(cpus);
  if (cpuErr) return new Response(cpuErr, { status: 400 });

  const existing = db.query("SELECT id FROM projects WHERE name = ?").get(name);
  if (existing) {
    return new Response("A project with this name already exists", { status: 409 });
  }

  const validPolicies = ["no", "on-failure", "always", "unless-stopped"];
  const policy = validPolicies.includes(restart_policy) ? restart_policy : "unless-stopped";

  const result = db
    .query(
      "INSERT INTO projects (name, github_url, docker_image, branch, dockerfile, domain, domain_port, restart_policy, memory_limit_mb, cpus) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *",
    )
    .get(
      name,
      docker_image ? null : (github_url ?? null),
      docker_image ?? null,
      branch ?? "main",
      dockerfile ?? "Dockerfile",
      domain?.trim() || null,
      domain_port ?? null,
      policy,
      memory_limit_mb ?? null,
      cpus ?? null,
    );

  if (domain?.trim()) {
    const failed = await applyCaddySync("Project");
    if (failed) return failed;
  }

  const safe = serializeProject(result as { github_url: string | null });
  console.log("[projects] created:", JSON.stringify(safe));
  return Response.json(safe, { status: 201 });
}

async function handleUpdate(req: Request, id: number): Promise<Response> {
  const body = await req.json();
  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  const validPolicies = ["no", "on-failure", "always", "unless-stopped"];

  if ("memory_limit_mb" in body) {
    const err = validateMemoryLimitMb(body.memory_limit_mb);
    if (err) return new Response(err, { status: 400 });
  }
  if ("cpus" in body) {
    const err = validateCpus(body.cpus);
    if (err) return new Response(err, { status: 400 });
  }

  // Reconciliation: if the incoming github_url matches the redacted form of the
  // stored URL, the caller is round-tripping a previous read (the web UI's edit
  // modal saving an unrelated field). Preserve the stored credentialed URL and
  // skip both the write and the source-switching side effect for that case.
  let skipGithubUrl = false;
  if ("github_url" in body) {
    const stored = db.query("SELECT github_url FROM projects WHERE id = ?").get(id) as {
      github_url: string | null;
    } | null;
    skipGithubUrl = reconcileGithubUrl(body.github_url, stored?.github_url ?? null).skip;
  }

  for (const key of [
    "name",
    "github_url",
    "docker_image",
    "branch",
    "dockerfile",
    "domain",
    "domain_port",
    "restart_policy",
    "memory_limit_mb",
    "cpus",
  ]) {
    if (key === "github_url" && skipGithubUrl) continue;
    if (key in body) {
      fields.push(`${key} = ?`);
      if (key === "domain") {
        values.push(body[key]?.trim() || null);
      } else if (key === "restart_policy") {
        values.push(validPolicies.includes(body[key]) ? body[key] : "unless-stopped");
      } else {
        // memory_limit_mb and cpus: null is the clear signal, numbers persist as-is.
        values.push(body[key]);
      }
    }
  }

  // When switching source type, clear the other. Reconciliation case is excluded:
  // a round-tripped read should not clear docker_image.
  if ("docker_image" in body && body.docker_image) {
    if (!fields.some((f) => f.startsWith("github_url"))) {
      fields.push("github_url = ?");
      values.push(null);
    }
  } else if ("github_url" in body && body.github_url && !skipGithubUrl) {
    if (!fields.some((f) => f.startsWith("docker_image"))) {
      fields.push("docker_image = ?");
      values.push(null);
    }
  }

  // Clear domain_port when domain is removed
  if ("domain" in body && !body.domain?.trim()) {
    if (!fields.some((f) => f.startsWith("domain_port"))) {
      fields.push("domain_port = ?");
      values.push(null);
    }
  }

  // A PUT whose only field is a round-tripped github_url is a no-op. Return the
  // current row rather than failing with "no fields to update", so the UI's
  // save-then-reload pattern keeps working.
  if (fields.length === 0) {
    if (skipGithubUrl) {
      const current = db.query("SELECT * FROM projects WHERE id = ?").get(id) as {
        github_url: string | null;
      } | null;
      if (!current) return new Response("Not found", { status: 404 });
      return Response.json(serializeProject(current));
    }
    return new Response("No fields to update", { status: 400 });
  }

  if ("name" in body && body.name) {
    const existing = db
      .query("SELECT id FROM projects WHERE name = ? AND id != ?")
      .get(body.name, id);
    if (existing) {
      return new Response("A project with this name already exists", { status: 409 });
    }
  }

  values.push(id);
  const row = db
    .query(`UPDATE projects SET ${fields.join(", ")} WHERE id = ? RETURNING *`)
    .get(...values);

  if (!row) return new Response("Not found", { status: 404 });

  // Sync Caddy if domain-related fields changed
  if ("domain" in body || "domain_port" in body) {
    const failed = await applyCaddySync("Project");
    if (failed) return failed;
  }

  return Response.json(serializeProject(row as { github_url: string | null }));
}
