import { apiGet, resolveProject } from "../client";

export async function logsCommand(args: string[]) {
  let follow = false;
  let tail = 100;
  let projectName: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-f" || args[i] === "--follow") {
      follow = true;
    } else if (args[i] === "-n" || args[i] === "--lines") {
      tail = Number(args[++i]);
    } else if (!projectName) {
      projectName = args[i];
    }
  }

  if (!projectName) {
    console.error("Usage: moor logs <project> [-f] [-n <lines>]");
    process.exit(1);
  }

  const project = await resolveProject(projectName);

  // Initial fetch with tail
  const res = await apiGet(`/api/projects/${project.id}/logs?tail=${tail}`);
  if (!res.ok) {
    console.error(`Failed to get logs: ${res.status}`);
    process.exit(1);
  }

  const data = (await res.json()) as { logs: string; lastTimestamp: number };
  if (data.logs) process.stdout.write(data.logs);

  if (!follow) return;

  // Poll for new logs
  let since = data.lastTimestamp;
  const poll = async () => {
    try {
      const res = await apiGet(`/api/projects/${project.id}/logs?since=${since}`);
      if (!res.ok) return;
      const data = (await res.json()) as { logs: string; lastTimestamp: number };
      if (data.logs?.trim()) {
        process.stdout.write(data.logs);
        since = data.lastTimestamp;
      }
    } catch {
      // Connection error, keep polling
    }
  };

  const interval = setInterval(poll, 2000);

  process.on("SIGINT", () => {
    clearInterval(interval);
    process.exit(0);
  });

  // Keep the process alive
  await new Promise(() => {});
}
