import { apiPost, resolveProject } from "../client";

export async function restartCommand(args: string[]) {
  const projectName = args[0];
  if (!projectName) {
    console.error("Usage: moor restart <project>");
    process.exit(1);
  }

  const project = await resolveProject(projectName);

  console.log(`Stopping ${project.name}...`);
  const stopRes = await apiPost(`/api/projects/${project.id}/stop`);
  if (!stopRes.ok) {
    console.error(`Failed to stop: ${await stopRes.text()}`);
    process.exit(1);
  }

  console.log(`Starting ${project.name}...`);
  const startRes = await apiPost(`/api/projects/${project.id}/start`);
  if (!startRes.ok) {
    console.error(`Failed to start: ${await startRes.text()}`);
    process.exit(1);
  }

  console.log(`${project.name} restarted.`);
}
