// #52 GET /api/projects/:id/container-stats — point-in-time live stats
// for one project's container. Memory is a single snapshot; CPU uses
// the cpu_stats / precpu_stats delta Docker already includes in the
// stream=false response (verified on the production host: precpu_stats
// is populated with a daemon-side prior sample ~1s back, so no
// client-side polling is needed).

import {
  buildStatsResponse,
  type ContainerStatsResponse,
  type DockerStatsPayload,
  isStoppedPayload,
  NOT_RUNNING,
} from "../container-stats";
import db from "../db";
import { SOCKET as SOCKET_PATH } from "../docker";

export async function handleContainerStats(req: Request, url: URL): Promise<Response | null> {
  const match = url.pathname.match(/^\/api\/projects\/(\d+)\/container-stats$/);
  if (!match || req.method !== "GET") return null;
  const projectId = Number(match[1]);

  const project = db.query("SELECT container_id FROM projects WHERE id = ?").get(projectId) as {
    container_id: string | null;
  } | null;
  if (!project) return new Response("Project not found", { status: 404 });

  // No container means the project was never started (or was deleted from
  // Docker). Return 200 with running=false so a batch caller doesn't have to
  // special-case 404.
  if (!project.container_id) {
    return Response.json(NOT_RUNNING satisfies ContainerStatsResponse);
  }

  try {
    const res = await fetch(
      `http://localhost/v1.44/containers/${encodeURIComponent(project.container_id)}/stats?stream=false`,
      { unix: SOCKET_PATH, signal: AbortSignal.timeout(10_000) },
    );
    // Container_id stale (container deleted/recreated under a new id): same
    // contract as no container_id at all — running=false, zeroed counters.
    if (res.status === 404) {
      return Response.json(NOT_RUNNING satisfies ContainerStatsResponse);
    }
    if (!res.ok) {
      return Response.json(
        { error: `docker GET /containers/.../stats -> ${res.status}` },
        { status: 502 },
      );
    }
    const payload = (await res.json()) as DockerStatsPayload;
    // Docker returns 200 (not 404) for a container that still exists but is
    // exited — with `read` set to the Go zero-time and stats fields null.
    // Without this check the route reported running=true with all zeros for
    // a stopped container, contradicting the documented contract.
    if (isStoppedPayload(payload)) {
      return Response.json(NOT_RUNNING satisfies ContainerStatsResponse);
    }
    return Response.json(buildStatsResponse(payload) satisfies ContainerStatsResponse);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return Response.json({ error: msg }, { status: 500 });
  }
}
