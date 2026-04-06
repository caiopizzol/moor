import { apiGet, apiPost, apiPut, resolveProject } from "../client";

type EnvVar = { key: string; value: string };

export async function envCommand(args: string[]) {
  const subcommand = args[0];

  if (subcommand === "list") return envList(args.slice(1));
  if (subcommand === "set") return envSet(args.slice(1));

  console.error("Usage: moor env <list|set> <project> [K=V ...]");
  process.exit(1);
}

async function envList(args: string[]) {
  const projectName = args[0];
  if (!projectName) {
    console.error("Usage: moor env list <project>");
    process.exit(1);
  }

  const project = await resolveProject(projectName);
  const res = await apiGet(`/api/projects/${project.id}/envs`);
  if (!res.ok) {
    console.error(`Failed: ${await res.text()}`);
    process.exit(1);
  }

  const vars = (await res.json()) as EnvVar[];
  if (vars.length === 0) {
    console.log("No environment variables set.");
    return;
  }
  for (const v of vars) {
    console.log(`${v.key}=${v.value}`);
  }
}

async function envSet(args: string[]) {
  const projectName = args[0];
  const pairs = args.slice(1);

  if (!projectName || pairs.length === 0) {
    console.error("Usage: moor env set <project> KEY=VALUE [KEY=VALUE ...]");
    process.exit(1);
  }

  // Parse K=V pairs
  const newVars: EnvVar[] = [];
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq === -1) {
      console.error(`Invalid format: "${pair}" (expected KEY=VALUE)`);
      process.exit(1);
    }
    newVars.push({ key: pair.slice(0, eq), value: pair.slice(eq + 1) });
  }

  const project = await resolveProject(projectName);

  // Fetch existing env vars and merge
  const existingRes = await apiGet(`/api/projects/${project.id}/envs`);
  if (!existingRes.ok) {
    console.error(`Failed to get env vars: ${await existingRes.text()}`);
    process.exit(1);
  }
  const existing = (await existingRes.json()) as EnvVar[];

  // Merge: new values overwrite existing keys
  const merged = new Map(existing.map((v) => [v.key, v.value]));
  for (const v of newVars) {
    merged.set(v.key, v.value);
  }
  const allVars = Array.from(merged, ([key, value]) => ({ key, value }));

  const setRes = await apiPut(`/api/projects/${project.id}/envs`, allVars);
  if (!setRes.ok) {
    console.error(`Failed to set env vars: ${await setRes.text()}`);
    process.exit(1);
  }

  for (const v of newVars) {
    console.log(`Set ${v.key}`);
  }

  // Restart if container is running
  if (project.status === "running") {
    console.log(`Restarting ${project.name}...`);
    await apiPost(`/api/projects/${project.id}/stop`);
    const startRes = await apiPost(`/api/projects/${project.id}/start`);
    if (!startRes.ok) {
      console.error(`Warning: failed to restart: ${await startRes.text()}`);
      process.exit(1);
    }
    console.log(`${project.name} restarted.`);
  }
}
