import db from "./db";
import { getImageExposedPorts } from "./docker";

export type PortMapping = {
  id: number;
  project_id: number;
  host_port: number;
  container_port: number;
  protocol: string;
};

/**
 * Find an available host port starting from containerPort.
 * Checks ALL existing mappings (including same project) to avoid UNIQUE constraint violations.
 */
export function findAvailableHostPort(containerPort: number): number {
  let port = containerPort;
  for (let i = 0; i < 100; i++) {
    const existing = db
      .query("SELECT id FROM port_mappings WHERE host_port = ? AND protocol = 'tcp'")
      .get(port);
    if (!existing) return port;
    port++;
  }
  throw new Error(`No available host port found starting from ${containerPort}`);
}

/**
 * Auto-detect exposed ports from a Docker image and persist them.
 * Always re-detects on rebuild (force=true) to catch changed EXPOSE directives.
 * Returns the resulting port mappings.
 */
export async function autoDetectPorts(
  projectId: number,
  imageTag: string,
  force = false,
): Promise<PortMapping[]> {
  if (!force) {
    const existing = getProjectPorts(projectId);
    if (existing.length > 0) return existing;
  }

  // Clear old mappings before re-detecting
  db.query("DELETE FROM port_mappings WHERE project_id = ?").run(projectId);

  const exposedPorts = await getImageExposedPorts(imageTag);
  if (exposedPorts.length === 0) return [];

  const insert = db.query(
    "INSERT OR IGNORE INTO port_mappings (project_id, host_port, container_port, protocol) VALUES (?, ?, ?, 'tcp')",
  );
  for (const containerPort of exposedPorts) {
    try {
      const hostPort = findAvailableHostPort(containerPort);
      insert.run(projectId, hostPort, containerPort);
    } catch {
      // No available port — skip this mapping
    }
  }

  return getProjectPorts(projectId);
}

export function getProjectPorts(projectId: number): PortMapping[] {
  return db
    .query(
      "SELECT id, project_id, host_port, container_port, protocol FROM port_mappings WHERE project_id = ? ORDER BY container_port",
    )
    .all(projectId) as PortMapping[];
}
