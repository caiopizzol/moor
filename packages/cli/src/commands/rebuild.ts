import { apiPost, resolveProject, streamSSE } from "../client";

export async function rebuildCommand(args: string[]) {
  let noCache = false;
  let projectName: string | undefined;

  for (const arg of args) {
    if (arg === "--no-cache") noCache = true;
    else if (!projectName) projectName = arg;
  }

  if (!projectName) {
    console.error("Usage: moor rebuild <project> [--no-cache]");
    process.exit(1);
  }

  const project = await resolveProject(projectName);
  const query = noCache ? "?nocache=true" : "";

  console.log(`Rebuilding ${project.name}...`);
  const res = await apiPost(`/api/projects/${project.id}/run${query}`);

  if (!res.ok && res.headers.get("content-type")?.includes("text/event-stream") === false) {
    const body = await res.text();
    console.error(`Failed: ${body}`);
    process.exit(1);
  }

  let failed = false;
  await streamSSE(res, {
    onLog: (text) => process.stdout.write(text),
    onError: (text) => {
      process.stderr.write(`Error: ${text}\n`);
      failed = true;
    },
    onDone: (text) => console.log(text),
  });

  process.exit(failed ? 1 : 0);
}
