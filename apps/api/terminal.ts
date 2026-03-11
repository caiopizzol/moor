import type { ServerWebSocket } from "bun";
import db from "./db";
import { inspectExec, SOCKET as SOCKET_PATH } from "./docker";
import {
  markDetached,
  setDockerSocket,
  setLastCommand,
  trackSession,
  untrackSession,
} from "./terminal-sessions";

type WsData = {
  projectId: number;
  containerId: string;
};

type WsExt = {
  _dockerSocket: { write: (data: string | Buffer) => void; end: () => void } | null;
  _execId: string;
  _cmdBuffer: string;
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
    const { containerId, projectId } = ws.data;
    console.log(`[terminal] WebSocket opened for container ${containerId.slice(0, 12)}`);

    let execId: string | undefined;
    try {
      execId = await createExec(containerId);
      console.log(`[terminal] exec created: ${execId.slice(0, 12)}`);
      trackSession(execId, projectId);

      // Open raw Unix socket to Docker and start the exec
      let headersParsed = false;
      let headerBuffer = "";

      const dockerSocket = await Bun.connect({
        unix: SOCKET_PATH,
        socket: {
          data(_socket, data) {
            if (!headersParsed) {
              headerBuffer += data.toString();
              const headerEnd = headerBuffer.indexOf("\r\n\r\n");
              if (headerEnd === -1) return;
              headersParsed = true;
              const remaining = headerBuffer.slice(headerEnd + 4);
              if (remaining.length > 0) ws.send(remaining);
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

      const wsAny = ws as unknown as WsExt;
      wsAny._dockerSocket = dockerSocket;
      wsAny._execId = execId;
      wsAny._cmdBuffer = "";

      setDockerSocket(execId, dockerSocket);

      dockerSocket.write(buildExecStartRequest(execId));
      console.log(`[terminal] exec started, streaming`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      console.error(`[terminal] setup failed: ${msg}`);
      if (execId) untrackSession(execId);
      ws.send(`\r\nError: ${msg}\r\n`);
      ws.close(1011, msg);
    }
  },

  message(ws: ServerWebSocket<WsData>, message: string | Buffer) {
    const wsAny = ws as unknown as WsExt;
    if (!wsAny._dockerSocket) return;

    // Check for resize messages
    if (typeof message === "string" && message.startsWith('{"type":"resize"')) {
      try {
        const { cols, rows } = JSON.parse(message);
        fetch(`http://localhost/v1.44/exec/${wsAny._execId}/resize?h=${rows}&w=${cols}`, {
          method: "POST",
          unix: SOCKET_PATH,
        }).catch(() => {});
        return;
      } catch {}
    }

    // Track keystrokes to capture last command
    const text = typeof message === "string" ? message : message.toString();
    let inEscape = false;
    for (const ch of text) {
      if (inEscape) {
        // Skip until final byte of escape sequence (a letter)
        if ((ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z")) {
          inEscape = false;
        }
        continue;
      }
      if (ch === "\x1b") {
        inEscape = true;
      } else if (ch === "\r" || ch === "\n") {
        const cmd = wsAny._cmdBuffer.trim();
        if (cmd) setLastCommand(wsAny._execId, cmd);
        wsAny._cmdBuffer = "";
      } else if (ch === "\x7f" || ch === "\x08") {
        wsAny._cmdBuffer = wsAny._cmdBuffer.slice(0, -1);
      } else if (ch === "\x03") {
        wsAny._cmdBuffer = "";
      } else if (ch >= " ") {
        wsAny._cmdBuffer += ch;
      }
    }

    wsAny._dockerSocket.write(message);
  },

  close(ws: ServerWebSocket<WsData>, code: number, reason: string) {
    console.log(`[terminal] WebSocket closed: ${code} ${reason}`);
    const wsAny = ws as unknown as WsExt;
    const execId = wsAny._execId;

    // Don't end the docker socket — keep it alive for detached sessions.
    // The session tracker holds a reference and will end it on kill.

    if (execId) {
      setTimeout(async () => {
        const data = await inspectExec(execId);
        if (data?.Running) {
          markDetached(execId);
        } else {
          untrackSession(execId);
        }
      }, 1000);
    }
  },
};
