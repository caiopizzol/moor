import { spawn } from "node:child_process";
import type { ServerWebSocket } from "bun";

type WsData = {
  type: "host";
};

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
    const pty = spawn(shell, ["-l"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, TERM: "xterm-256color" },
    });

    (ws as unknown as { _proc: typeof pty })._proc = pty;

    pty.stdout?.on("data", (data: Buffer) => {
      try {
        ws.send(data);
      } catch {}
    });

    pty.stderr?.on("data", (data: Buffer) => {
      try {
        ws.send(data);
      } catch {}
    });

    pty.on("close", (code) => {
      console.log(`[host-terminal] process exited with code ${code}`);
      try {
        ws.close(1000, "Shell exited");
      } catch {}
    });

    pty.on("error", (err) => {
      console.error("[host-terminal] process error:", err.message);
      try {
        ws.close(1011, "Shell error");
      } catch {}
    });
  },

  message(ws: ServerWebSocket<WsData>, message: string | Buffer) {
    const proc = (ws as unknown as { _proc: ReturnType<typeof spawn> })._proc;
    if (!proc?.stdin?.writable) return;

    if (typeof message === "string" && message.startsWith('{"type":"resize"')) {
      // Resize not supported with child_process — ignore
      return;
    }

    proc.stdin.write(message);
  },

  close(ws: ServerWebSocket<WsData>) {
    console.log("[host-terminal] WebSocket closed");
    const proc = (ws as unknown as { _proc: ReturnType<typeof spawn> })._proc;
    if (proc) {
      proc.kill();
    }
  },
};
