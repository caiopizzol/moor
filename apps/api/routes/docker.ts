import db from "../db";
import {
  buildImage,
  buildImageStreaming,
  createAndStartContainer,
  execInContainer,
  getContainerLogs,
  stopContainer,
} from "../docker";
import { autoDetectPorts, getProjectPorts } from "../ports";

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

function validateGithubUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.endsWith("github.com")) return "Only GitHub URLs are supported";
  } catch {
    return "Invalid GitHub URL";
  }
  return null;
}

export async function handleDocker(req: Request, url: URL): Promise<Response | null> {
  const match = url.pathname.match(/^\/api\/projects\/(\d+)\/(build|start|stop|run|logs|exec)$/);
  if (!match) return null;

  const id = Number(match[1]);
  const action = match[2];
  console.log(`[docker] ${req.method} /api/projects/${id}/${action}`);

  const project = db.query("SELECT * FROM projects WHERE id = ?").get(id) as Project | null;
  if (!project) {
    console.log(`[docker] project ${id} not found`);
    return new Response("Not found", { status: 404 });
  }
  console.log(
    `[docker] project: name=${project.name} status=${project.status} image=${project.image_tag} container=${project.container_id}`,
  );

  if (action === "build" && req.method === "POST") return handleBuild(project);
  if (action === "start" && req.method === "POST") return handleStart(project);
  if (action === "stop" && req.method === "POST") return handleStop(project);
  if (action === "run" && req.method === "POST") return handleRun(req, project);
  if (action === "logs" && req.method === "GET") return handleLogs(project, url);
  if (action === "exec" && req.method === "POST") return handleExec(req, project);

  return null;
}

async function handleRun(req: Request, project: Project): Promise<Response> {
  const url = new URL(req.url);
  const noCache = url.searchParams.get("nocache") === "true";
  console.log(
    `[run] starting run for project ${project.name} (id=${project.id}) nocache=${noCache}`,
  );

  if (!project.github_url) {
    if (project.image_tag) {
      console.log("[run] no github_url, starting existing image");
      return handleStart(project);
    }
    console.log("[run] no github_url or image_tag — nothing to do");
    return new Response("No GitHub URL or image configured", { status: 400 });
  }

  const urlError = validateGithubUrl(project.github_url);
  if (urlError) return new Response(urlError, { status: 400 });

  const tag = `moor/${project.name}:latest`;
  console.log(
    `[run] github_url=${project.github_url} branch=${project.branch} dockerfile=${project.dockerfile}`,
  );
  console.log(`[run] image tag will be: ${tag}`);
  db.query("UPDATE projects SET status = 'building' WHERE id = ?").run(project.id);

  // Stream build output via SSE
  let streamClosed = false;
  let keepalive: ReturnType<typeof setInterval>;
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      const send = (event: string, data: string) => {
        if (streamClosed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          streamClosed = true;
        }
      };

      const safeClose = () => {
        clearInterval(keepalive);
        if (streamClosed) return;
        streamClosed = true;
        try {
          controller.close();
        } catch {
          // Already closed
        }
      };

      // Send SSE keepalive comments every 5s to prevent idle timeout
      keepalive = setInterval(() => {
        if (streamClosed) return;
        try {
          controller.enqueue(encoder.encode(":keepalive\n\n"));
        } catch {
          streamClosed = true;
        }
      }, 5000);

      let buildOutput = "";
      const buildStart = Date.now();

      try {
        buildOutput = await buildImageStreaming(
          project.github_url as string,
          project.branch,
          project.dockerfile,
          tag,
          (line) => send("log", line),
          noCache,
        );

        const elapsed = ((Date.now() - buildStart) / 1000).toFixed(1);

        db.query("UPDATE projects SET image_tag = ?, status = 'stopped' WHERE id = ?").run(
          tag,
          project.id,
        );
        db.query(
          `INSERT INTO runs (project_id, started_at, finished_at, exit_code, stdout, cron_id)
           VALUES (?, datetime('now'), datetime('now'), 0, ?, NULL)`,
        ).run(project.id, buildOutput);

        send("log", `\nBuild completed in ${elapsed}s\n`);

        // Auto-detect exposed ports from image (always re-detect on rebuild)
        const detectedPorts = await autoDetectPorts(project.id, tag, true);
        for (const { host_port, container_port } of detectedPorts) {
          send("log", `Port ${container_port} → host :${host_port}\n`);
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : "Unknown error";
        console.error(`[run] BUILD FAILED: ${message}`);
        db.query(
          `INSERT INTO runs (project_id, started_at, finished_at, exit_code, stdout, cron_id)
           VALUES (?, datetime('now'), datetime('now'), 1, ?, NULL)`,
        ).run(project.id, buildOutput || message);
        db.query("UPDATE projects SET status = 'error' WHERE id = ?").run(project.id);
        send("error", message);
        safeClose();
        return;
      }

      // Start the container
      try {
        const envs = db
          .query("SELECT key, value FROM env_vars WHERE project_id = ?")
          .all(project.id) as { key: string; value: string }[];
        const ports = getProjectPorts(project.id);

        send("log", "Starting container...\n");
        const containerId = await createAndStartContainer(tag, `moor-${project.name}`, envs, ports);
        console.log(`[run] container started: ${containerId}`);

        db.query("UPDATE projects SET container_id = ?, status = 'running' WHERE id = ?").run(
          containerId,
          project.id,
        );
        send("done", "Container started");
      } catch (e) {
        db.query("UPDATE projects SET status = 'error' WHERE id = ?").run(project.id);
        const message = e instanceof Error ? e.message : "Unknown error";
        console.error(`[run] CONTAINER START FAILED: ${message}`);
        send("error", message);
      }

      safeClose();
    },
    cancel() {
      clearInterval(keepalive);
      streamClosed = true;
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
  console.log(
    `[exec] project=${project.name} container=${project.container_id} status=${project.status}`,
  );
  if (!project.container_id || project.status !== "running") {
    console.log("[exec] rejected — container not running");
    return new Response("Container is not running", { status: 400 });
  }

  const body = (await req.json()) as { command?: string };
  if (!body.command) {
    return new Response("Missing command", { status: 400 });
  }

  console.log(`[exec] command: ${body.command}`);
  try {
    const result = await execInContainer(project.container_id, body.command);
    console.log(
      `[exec] exitCode=${result.exitCode} stdout=${result.stdout.length}chars stderr=${result.stderr.length}chars`,
    );
    return Response.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    console.error(`[exec] FAILED: ${message}`);
    return new Response(message, { status: 500 });
  }
}

async function handleBuild(project: Project): Promise<Response> {
  console.log(`[build] project=${project.name} github_url=${project.github_url}`);
  if (!project.github_url) {
    console.log("[build] rejected — no github_url");
    return new Response("No GitHub URL configured", { status: 400 });
  }
  const urlError = validateGithubUrl(project.github_url);
  if (urlError) return new Response(urlError, { status: 400 });

  const tag = `moor/${project.name}:latest`;
  console.log(`[build] tag=${tag} branch=${project.branch} dockerfile=${project.dockerfile}`);
  db.query("UPDATE projects SET status = 'building' WHERE id = ?").run(project.id);

  try {
    console.log("[build] starting docker build...");
    const buildStart = Date.now();
    const buildOutput = await buildImage(
      project.github_url,
      project.branch,
      project.dockerfile,
      tag,
    );
    console.log(
      `[build] completed in ${((Date.now() - buildStart) / 1000).toFixed(1)}s (${buildOutput.length} chars)`,
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

    // Auto-detect exposed ports from image (always re-detect on rebuild)
    await autoDetectPorts(project.id, tag, true);

    console.log("[build] done — status set to 'stopped'");
    return Response.json({ message: "Build complete" });
  } catch (e) {
    db.query("UPDATE projects SET status = 'error' WHERE id = ?").run(project.id);
    const message = e instanceof Error ? e.message : "Unknown error";
    console.error(`[build] FAILED: ${message}`);
    return new Response(message, { status: 500 });
  }
}

async function handleStart(project: Project): Promise<Response> {
  console.log(`[start] project=${project.name} image=${project.image_tag}`);
  if (!project.image_tag) {
    console.log("[start] rejected — no image built");
    return new Response("No image built yet", { status: 400 });
  }

  const envs = db.query("SELECT key, value FROM env_vars WHERE project_id = ?").all(project.id) as {
    key: string;
    value: string;
  }[];
  const ports = getProjectPorts(project.id);
  console.log(
    `[start] creating container moor-${project.name} with ${envs.length} env vars and ${ports.length} ports`,
  );

  try {
    const containerId = await createAndStartContainer(
      project.image_tag,
      `moor-${project.name}`,
      envs,
      ports,
    );
    console.log(`[start] container started: ${containerId}`);
    db.query("UPDATE projects SET container_id = ?, status = 'running' WHERE id = ?").run(
      containerId,
      project.id,
    );
    return Response.json({ message: "Container started" });
  } catch (e) {
    db.query("UPDATE projects SET status = 'error' WHERE id = ?").run(project.id);
    const message = e instanceof Error ? e.message : "Unknown error";
    console.error(`[start] FAILED: ${message}`);
    return new Response(message, { status: 500 });
  }
}

async function handleStop(project: Project): Promise<Response> {
  console.log(`[stop] project=${project.name} container=${project.container_id}`);
  if (!project.container_id) {
    console.log("[stop] no container — marking as stopped");
    db.query("UPDATE projects SET status = 'stopped' WHERE id = ?").run(project.id);
    return Response.json({ message: "Container stopped" });
  }

  try {
    await stopContainer(project.container_id);
    console.log("[stop] container stopped");
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    console.error(`[stop] error during stop (marking as stopped anyway): ${message}`);
  }

  db.query("UPDATE projects SET status = 'stopped' WHERE id = ?").run(project.id);
  return Response.json({ message: "Container stopped" });
}
