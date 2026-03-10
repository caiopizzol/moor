import type { ServerWebSocket } from "bun";
import { type Subprocess, spawn } from "bun";

type WsData = {
  type: "host";
};

type PtyState = {
  proc: Subprocess;
  cols: number;
  rows: number;
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

    // Use `script` to allocate a PTY on Linux without native deps.
    // `script -q /dev/null` creates a PTY and runs the default shell.
    const proc = spawn(["script", "-q", "/dev/null", shell, "-l"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLUMNS: "80",
        LINES: "24",
      },
    });

    const state: PtyState = { proc, cols: 80, rows: 24 };
    (ws as unknown as { _pty: PtyState })._pty = state;

    // Stream stdout to WebSocket
    if (proc.stdout) {
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            try {
              ws.send(decoder.decode(value));
            } catch {
              break;
            }
          }
        } catch {
          // stream closed
        }
        try {
          ws.close(1000, "Shell exited");
        } catch {}
      })();
    }

    // Stream stderr to WebSocket too
    if (proc.stderr) {
      const reader = proc.stderr.getReader();
      const decoder = new TextDecoder();
      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            try {
              ws.send(decoder.decode(value));
            } catch {
              break;
            }
          }
        } catch {
          // stream closed
        }
      })();
    }

    proc.exited.then((code) => {
      console.log(`[host-terminal] process exited with code ${code}`);
      try {
        ws.close(1000, "Shell exited");
      } catch {}
    });
  },

  message(ws: ServerWebSocket<WsData>, message: string | Buffer) {
    const state = (ws as unknown as { _pty: PtyState })._pty;
    const stdin = state?.proc.stdin;
    if (!stdin || typeof stdin === "number") return;

    if (typeof message === "string" && message.startsWith('{"type":"resize"')) {
      try {
        const { cols, rows } = JSON.parse(message);
        state.cols = cols;
        state.rows = rows;
        stdin.write(new TextEncoder().encode(`\x1b[8;${rows};${cols}t`));
      } catch {}
      return;
    }

    const data = typeof message === "string" ? new TextEncoder().encode(message) : message;
    stdin.write(data);
  },

  close(ws: ServerWebSocket<WsData>) {
    console.log("[host-terminal] WebSocket closed");
    const state = (ws as unknown as { _pty: PtyState })._pty;
    if (state?.proc) {
      state.proc.kill();
    }
  },
};
