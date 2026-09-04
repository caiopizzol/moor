import { apiPost, readErrorMessage, resolveProject } from "../client";

export async function restartCommand(args: string[]) {
  const projectName = args[0];
  if (!projectName) {
    console.error("Usage: moor restart <project>");
    process.exit(1);
  }

  const project = await resolveProject(projectName);

  console.log(`Restarting ${project.name}...`);
  const res = await apiPost(`/api/projects/${project.id}/restart`);
  if (!res.ok) {
    console.error(`Failed to restart: ${await readErrorMessage(res)}`);
    process.exit(1);
  }

  console.log(`${project.name} restarted.`);
}
