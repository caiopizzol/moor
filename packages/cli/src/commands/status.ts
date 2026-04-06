import { apiGet } from "../client";

type Project = {
  id: number;
  name: string;
  status: string;
  image_tag: string | null;
  domain: string | null;
  docker_image: string | null;
  github_url: string | null;
};

export async function statusCommand() {
  const res = await apiGet("/api/projects");
  if (!res.ok) {
    console.error(`Failed to list projects: ${res.status}`);
    process.exit(1);
  }

  const projects = (await res.json()) as Project[];
  if (projects.length === 0) {
    console.log("No projects found.");
    return;
  }

  // Calculate column widths
  const nameW = Math.max(4, ...projects.map((p) => p.name.length));
  const statusW = Math.max(6, ...projects.map((p) => p.status.length));
  const sourceW = Math.max(
    6,
    ...projects.map((p) => (p.docker_image || p.github_url || "-").length),
  );
  const domainW = Math.max(6, ...projects.map((p) => (p.domain || "-").length));

  const header = [
    "NAME".padEnd(nameW),
    "STATUS".padEnd(statusW),
    "SOURCE".padEnd(sourceW),
    "DOMAIN".padEnd(domainW),
  ].join("  ");

  console.log(header);
  console.log("-".repeat(header.length));

  for (const p of projects) {
    const source = p.docker_image || p.github_url || "-";
    console.log(
      [
        p.name.padEnd(nameW),
        p.status.padEnd(statusW),
        source.padEnd(sourceW),
        (p.domain || "-").padEnd(domainW),
      ].join("  "),
    );
  }
}
