import { apiPost, resolveProject } from "../client";

export async function execCommand(args: string[]) {
  const projectName = args[0];
  const command = args.slice(1).join(" ");

  if (!projectName || !command) {
    console.error("Usage: moor exec <project> <command>");
    process.exit(1);
  }

  const project = await resolveProject(projectName);
  const res = await apiPost(`/api/projects/${project.id}/exec`, { command });

  if (!res.ok) {
    console.error(`Failed: ${await res.text()}`);
    process.exit(1);
  }

  const result = (await res.json()) as {
    exitCode: number;
    stdout: string;
    stderr: string;
  };

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.exitCode);
}
