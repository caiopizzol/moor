import db from "../db";
import { buildImage, createAndStartContainer, stopContainer } from "../docker";

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
  const match = url.pathname.match(/^\/api\/projects\/(\d+)\/(build|start|stop)$/);
  if (!match || req.method !== "POST") return null;

  const id = Number(match[1]);
  const action = match[2];
  const project = db.query("SELECT * FROM projects WHERE id = ?").get(id) as Project | null;
  if (!project) return new Response("Not found", { status: 404 });

  if (action === "build") return handleBuild(project);
  if (action === "start") return handleStart(project);
  if (action === "stop") return handleStop(project);

  return null;
}

async function handleBuild(project: Project): Promise<Response> {
  if (!project.github_url) {
    return new Response("No GitHub URL configured", { status: 400 });
  }

  const tag = `moor/${project.name}:latest`;
  db.query("UPDATE projects SET status = 'building' WHERE id = ?").run(project.id);

  try {
    await buildImage(project.github_url, project.branch, project.dockerfile, tag);
    db.query("UPDATE projects SET image_tag = ?, status = 'stopped' WHERE id = ?").run(
      tag,
      project.id,
    );
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
