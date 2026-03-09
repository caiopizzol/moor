import db from "../db";
import {
  buildImage,
  createAndStartContainer,
  execInContainer,
  getContainerLogs,
  stopContainer,
} from "../docker";

type Project = {
  id: number;
  name: string;
  github_url: string | null;
  branch: string;
  dockerfile: string;
  image_tag: string | null;
  container_id: string | null;
  status: string;
};

export async function handleDocker(req: Request, url: URL): Promise<Response | null> {
  const match = url.pathname.match(/^\/api\/projects\/(\d+)\/(build|start|stop|run|logs|exec)$/);
  if (!match) return null;

  const id = Number(match[1]);
  const action = match[2];
  const project = db.query("SELECT * FROM projects WHERE id = ?").get(id) as Project | null;
  if (!project) return new Response("Not found", { status: 404 });

  if (action === "build" && req.method === "POST") return handleBuild(project);
  if (action === "start" && req.method === "POST") return handleStart(project);
  if (action === "stop" && req.method === "POST") return handleStop(project);
  if (action === "run" && req.method === "POST") return handleRun(project);
  if (action === "logs" && req.method === "GET") return handleLogs(project, url);
  if (action === "exec" && req.method === "POST") return handleExec(req, project);

  return null;
}

async function handleRun(project: Project): Promise<Response> {
  // If github_url exists, build first then start
  if (project.github_url) {
    const tag = `moor/${project.name}:latest`;
    db.query("UPDATE projects SET status = 'building' WHERE id = ?").run(project.id);

    let buildOutput: string;
    try {
      buildOutput = await buildImage(project.github_url, project.branch, project.dockerfile, tag);
      db.query("UPDATE projects SET image_tag = ?, status = 'stopped' WHERE id = ?").run(
        tag,
        project.id,
      );

      // Store build output in runs table
      db.query(
        `INSERT INTO runs (project_id, started_at, finished_at, exit_code, stdout, cron_id)
         VALUES (?, datetime('now'), datetime('now'), 0, ?, NULL)`,
      ).run(project.id, buildOutput);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Unknown error";
      // Store failed build output
      db.query(
        `INSERT INTO runs (project_id, started_at, finished_at, exit_code, stdout, cron_id)
         VALUES (?, datetime('now'), datetime('now'), 1, ?, NULL)`,
      ).run(project.id, message);
      db.query("UPDATE projects SET status = 'error' WHERE id = ?").run(project.id);
      return new Response(message, { status: 500 });
    }

    // Now start the container
    const envs = db
      .query("SELECT key, value FROM env_vars WHERE project_id = ?")
      .all(project.id) as { key: string; value: string }[];

    try {
      const containerId = await createAndStartContainer(tag, `moor-${project.name}`, envs);
      db.query("UPDATE projects SET container_id = ?, status = 'running' WHERE id = ?").run(
        containerId,
        project.id,
      );
      return Response.json({ message: "Build complete, container started" });
    } catch (e) {
      db.query("UPDATE projects SET status = 'error' WHERE id = ?").run(project.id);
      const message = e instanceof Error ? e.message : "Unknown error";
      return new Response(message, { status: 500 });
    }
  }

  // If image_tag exists but no github_url, just start
  if (project.image_tag) {
    return handleStart(project);
  }

  return new Response("No GitHub URL or image configured", { status: 400 });
}

async function handleLogs(project: Project, url: URL): Promise<Response> {
  if (!project.container_id) {
    return Response.json({ logs: "" });
  }

  const tail = Number(url.searchParams.get("tail") || "100");
  try {
    const logs = await getContainerLogs(project.container_id, tail);
    return Response.json({ logs });
  } catch {
    return Response.json({ logs: "" });
  }
}

async function handleExec(req: Request, project: Project): Promise<Response> {
  if (!project.container_id || project.status !== "running") {
    return new Response("Container is not running", { status: 400 });
  }

  const body = (await req.json()) as { command?: string };
  if (!body.command) {
    return new Response("Missing command", { status: 400 });
  }

  try {
    const result = await execInContainer(project.container_id, body.command);
    return Response.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return new Response(message, { status: 500 });
  }
}

async function handleBuild(project: Project): Promise<Response> {
  if (!project.github_url) {
    return new Response("No GitHub URL configured", { status: 400 });
  }

  const tag = `moor/${project.name}:latest`;
  db.query("UPDATE projects SET status = 'building' WHERE id = ?").run(project.id);

  try {
    const buildOutput = await buildImage(
      project.github_url,
      project.branch,
      project.dockerfile,
      tag,
    );
    db.query("UPDATE projects SET image_tag = ?, status = 'stopped' WHERE id = ?").run(
      tag,
      project.id,
    );

    // Store build output in runs table
    db.query(
      `INSERT INTO runs (project_id, started_at, finished_at, exit_code, stdout, cron_id)
       VALUES (?, datetime('now'), datetime('now'), 0, ?, NULL)`,
    ).run(project.id, buildOutput);

    return Response.json({ message: "Build complete" });
  } catch (e) {
    db.query("UPDATE projects SET status = 'error' WHERE id = ?").run(project.id);
    const message = e instanceof Error ? e.message : "Unknown error";
    return new Response(message, { status: 500 });
  }
}

async function handleStart(project: Project): Promise<Response> {
  if (!project.image_tag) {
    return new Response("No image built yet", { status: 400 });
  }

  const envs = db.query("SELECT key, value FROM env_vars WHERE project_id = ?").all(project.id) as {
    key: string;
    value: string;
  }[];

  try {
    const containerId = await createAndStartContainer(
      project.image_tag,
      `moor-${project.name}`,
      envs,
    );
    db.query("UPDATE projects SET container_id = ?, status = 'running' WHERE id = ?").run(
      containerId,
      project.id,
    );
    return Response.json({ message: "Container started" });
  } catch (e) {
    db.query("UPDATE projects SET status = 'error' WHERE id = ?").run(project.id);
    const message = e instanceof Error ? e.message : "Unknown error";
    return new Response(message, { status: 500 });
  }
}

async function handleStop(project: Project): Promise<Response> {
  if (!project.container_id) {
    return new Response("No container running", { status: 400 });
  }

  try {
    await stopContainer(project.container_id);
    db.query("UPDATE projects SET status = 'stopped' WHERE id = ?").run(project.id);
    return Response.json({ message: "Container stopped" });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return new Response(message, { status: 500 });
  }
}
