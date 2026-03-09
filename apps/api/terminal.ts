import type { ServerWebSocket } from "bun";
import db from "./db";
import { SOCKET as SOCKET_PATH } from "./docker";

type WsData = {
  projectId: number;
  containerId: string;
};

/** Upgrade an HTTP request to a terminal WebSocket */
export function upgradeTerminal(
  req: Request,
  server: ReturnType<typeof Bun.serve>,
): Response | true {
  const url = new URL(req.url);
  const match = url.pathname.match(/^\/api\/projects\/(\d+)\/terminal$/);
  if (!match) return new Response("Not found", { status: 404 });

  const projectId = Number(match[1]);
  const project = db.query("SELECT * FROM projects WHERE id = ?").get(projectId) as {
    container_id: string | null;
    status: string;
  } | null;

  if (!project?.container_id || project.status !== "running") {
    return new Response("Container is not running", { status: 400 });
  }

  const upgraded = server.upgrade(req, {
    data: { projectId, containerId: project.container_id },
  });

  if (upgraded) return true;
  return new Response("WebSocket upgrade failed", { status: 500 });
}

/** Create a Docker exec with TTY, return the exec ID */
async function createExec(containerId: string): Promise<string> {
  const res = await fetch(`http://localhost/v1.44/containers/${containerId}/exec`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      Cmd: ["/bin/sh"],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
    }),
    unix: SOCKET_PATH,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Exec create failed: ${res.status} ${body}`);
  }

  const { Id } = (await res.json()) as { Id: string };
  return Id;
}

/** Build the raw HTTP request to start an exec and stream via raw socket */
function buildExecStartRequest(execId: string): string {
  const body = JSON.stringify({ Detach: false, Tty: true });
  return [
    `POST /v1.44/exec/${execId}/start HTTP/1.1`,
    "Host: localhost",
    "Content-Type: application/json",
    `Content-Length: ${body.length}`,
    "Connection: Upgrade",
    "Upgrade: tcp",
    "",
    body,
  ].join("\r\n");
}

export const terminalWebSocket = {
  async open(ws: ServerWebSocket<WsData>) {
    const { containerId } = ws.data;
    console.log(`[terminal] WebSocket opened for container ${containerId.slice(0, 12)}`);

    try {
      const execId = await createExec(containerId);
      console.log(`[terminal] exec created: ${execId.slice(0, 12)}`);

      // Open raw Unix socket to Docker and start the exec
      let headersParsed = false;
      let headerBuffer = "";

      const dockerSocket = await Bun.connect({
        unix: SOCKET_PATH,
        socket: {
          data(_socket, data) {
            // Skip HTTP response headers from the exec/start response
            if (!headersParsed) {
              headerBuffer += data.toString();
              console.log(
                `[terminal] raw header data: ${JSON.stringify(headerBuffer.slice(0, 200))}`,
              );
              const headerEnd = headerBuffer.indexOf("\r\n\r\n");
              if (headerEnd === -1) return; // still reading headers
              headersParsed = true;
              console.log(
                `[terminal] headers parsed, status: ${headerBuffer.slice(0, headerBuffer.indexOf("\r\n"))}`,
              );
              // Send any data after the headers
              const remaining = headerBuffer.slice(headerEnd + 4);
              if (remaining.length > 0) {
                console.log(`[terminal] sending initial data: ${remaining.length} bytes`);
                ws.send(remaining);
              }
              return;
            }

            ws.send(data);
          },
          error(_socket, err) {
            console.error("[terminal] Docker socket error:", err.message);
            ws.close(1011, "Docker connection error");
          },
          close() {
            console.log("[terminal] Docker socket closed");
            ws.close(1000, "Docker connection closed");
          },
        },
      });

      // Store the socket reference on the ws for use in message/close handlers
      (ws as unknown as { _dockerSocket: typeof dockerSocket })._dockerSocket = dockerSocket;

      // Send the exec/start request over the raw socket
      dockerSocket.write(buildExecStartRequest(execId));
      console.log(`[terminal] exec started, streaming`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      console.error(`[terminal] setup failed: ${msg}`);
      ws.send(`\r\nError: ${msg}\r\n`);
      ws.close(1011, msg);
    }
  },

  message(ws: ServerWebSocket<WsData>, message: string | Buffer) {
    console.log(
      `[terminal] ws message received: ${typeof message === "string" ? message.length : (message as Buffer).length} bytes`,
    );
    const dockerSocket = (
      ws as unknown as { _dockerSocket: { write: (data: string | Buffer) => void } }
    )._dockerSocket;
    if (dockerSocket) {
      // Check for resize messages
      if (typeof message === "string" && message.startsWith('{"type":"resize"')) {
        try {
          const { cols, rows } = JSON.parse(message);
          // Resize the exec TTY via Docker API
          fetch(
            `http://localhost/v1.44/exec/${(ws as unknown as { _execId: string })._execId}/resize?h=${rows}&w=${cols}`,
            {
              method: "POST",
              unix: SOCKET_PATH,
            },
          ).catch(() => {});
          return;
        } catch {}
      }
      dockerSocket.write(message);
    }
  },

  close(ws: ServerWebSocket<WsData>, code: number, reason: string) {
    console.log(`[terminal] WebSocket closed: ${code} ${reason}`);
    const dockerSocket = (ws as unknown as { _dockerSocket: { end: () => void } })._dockerSocket;
    if (dockerSocket) {
      dockerSocket.end();
    }
  },
};
