import { inspectExec } from "./docker";

type DockerSocket = { write: (data: string | Uint8Array) => void; end: () => void };

type TerminalSession = {
  execId: string;
  projectId: number;
  startedAt: string;
  detached: boolean;
  lastCommand: string;
  dockerSocket: DockerSocket | null;
};

const sessions = new Map<string, TerminalSession>();

export function trackSession(execId: string, projectId: number) {
  sessions.set(execId, {
    execId,
    projectId,
    startedAt: new Date().toISOString(),
    detached: false,
    lastCommand: "",
    dockerSocket: null,
  });
  console.log(`[sessions] tracking exec ${execId.slice(0, 12)} for project ${projectId}`);
}

export function untrackSession(execId: string) {
  const session = sessions.get(execId);
  if (session?.dockerSocket) {
    try {
      session.dockerSocket.end();
    } catch {
      // already closed
    }
  }
  sessions.delete(execId);
}

export function setDockerSocket(execId: string, socket: DockerSocket) {
  const session = sessions.get(execId);
  if (session) session.dockerSocket = socket;
}

export function setLastCommand(execId: string, command: string) {
  const session = sessions.get(execId);
  if (session) session.lastCommand = command;
}

export function getLastCommand(execId: string): string {
  return sessions.get(execId)?.lastCommand ?? "";
}

export function markDetached(execId: string) {
  const session = sessions.get(execId);
  if (session) {
    session.detached = true;
    console.log(
      `[sessions] exec ${execId.slice(0, 12)} detached (command: "${session.lastCommand || "/bin/sh"}")`,
    );
  }
}

export type SessionInfo = {
  execId: string;
  projectId: number;
  startedAt: string;
  lastCommand: string;
};

export function getSessionsForProject(projectId: number): SessionInfo[] {
  return [...sessions.values()]
    .filter((s) => s.projectId === projectId && s.detached)
    .map(({ execId, projectId, startedAt, lastCommand }) => ({
      execId,
      projectId,
      startedAt,
      lastCommand,
    }));
}

function closeSocket(socket: DockerSocket | null) {
  if (!socket) return;
  try {
    socket.write("\x03\nexit\n");
    socket.end();
  } catch {
    // Socket may already be closed
  }
}

export async function killSession(execId: string): Promise<boolean> {
  const session = sessions.get(execId);
  if (!session) return false;

  // Send Ctrl+C then exit through the Docker socket
  closeSocket(session.dockerSocket);

  // Wait briefly then verify the exec actually stopped
  await new Promise((r) => setTimeout(r, 500));
  const data = await inspectExec(execId);
  if (data?.Running) {
    console.log(`[sessions] exec ${execId.slice(0, 12)} still running after socket kill`);
  }

  sessions.delete(execId);
  console.log(`[sessions] killed exec ${execId.slice(0, 12)}`);
  return true;
}

async function cleanupSessions() {
  for (const [execId, session] of sessions) {
    if (!session.detached) continue;
    const data = await inspectExec(execId);
    if (!data || !data.Running) {
      closeSocket(session.dockerSocket);
      sessions.delete(execId);
      console.log(`[sessions] exec ${execId.slice(0, 12)} exited, removed`);
    }
  }
}

export function startSessionCleanup() {
  setInterval(cleanupSessions, 30_000);
}

export function clearAllSessions() {
  for (const session of sessions.values()) {
    closeSocket(session.dockerSocket);
  }
  sessions.clear();
}
