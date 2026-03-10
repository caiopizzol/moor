import type { ServerWebSocket } from "bun";
import * as pty from "node-pty";

type WsData = {
  type: "host";
};

type PtyProcess = pty.IPty;

/** Upgrade an HTTP request to a host terminal WebSocket */
export function upgradeHostTerminal(
  req: Request,
  server: ReturnType<typeof Bun.serve>,
): Response | true {
  const upgraded = server.upgrade(req, {
    data: { type: "host" } as WsData,
  });
  if (upgraded) return true;
  return new Response("WebSocket upgrade failed", { status: 500 });
}

/** Check if WsData is a host terminal */
export function isHostTerminal(data: unknown): data is WsData {
  return (data as WsData)?.type === "host";
}

export const hostTerminalHandlers = {
  open(ws: ServerWebSocket<WsData>) {
    console.log("[host-terminal] WebSocket opened");

    const shell = process.env.SHELL || "/bin/sh";
    const proc = pty.spawn(shell, ["-l"], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      env: process.env as Record<string, string>,
    });

    (ws as unknown as { _pty: PtyProcess })._pty = proc;

    proc.onData((data) => {
      try {
        ws.send(data);
      } catch {}
    });

    proc.onExit(({ exitCode }) => {
      console.log(`[host-terminal] process exited with code ${exitCode}`);
      try {
        ws.close(1000, "Shell exited");
      } catch {}
    });
  },

  message(ws: ServerWebSocket<WsData>, message: string | Buffer) {
    const proc = (ws as unknown as { _pty: PtyProcess })._pty;
    if (!proc) return;

    if (typeof message === "string" && message.startsWith('{"type":"resize"')) {
      try {
        const { cols, rows } = JSON.parse(message);
        proc.resize(cols, rows);
      } catch {}
      return;
    }

    proc.write(typeof message === "string" ? message : message.toString());
  },

  close(ws: ServerWebSocket<WsData>) {
    console.log("[host-terminal] WebSocket closed");
    const proc = (ws as unknown as { _pty: PtyProcess })._pty;
    if (proc) {
      proc.kill();
    }
  },
};
