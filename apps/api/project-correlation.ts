// #131: map a Docker container back to its moor project. Two paths, label
// preferred:
//   - labels: a moor-created container carries sh.moor.project_id (#131). The
//     Docker /events consumer reads it from the event's Actor.Attributes — no
//     DB round-trip and no create/start timing gap (the label is set at create
//     time, before container_id is ever written back to the projects row).
//   - fallback: containers created before labels shipped have none, so match
//     on projects.container_id.
// Returns null when neither resolves: an event for a non-moor container, or a
// project row that's already gone. The label path still verifies the project
// exists so a stale label can't produce a dangling project_id (the
// project_events FK would reject it anyway).

import db from "./db";
import { LABEL_PROJECT_ID } from "./docker";

export function resolveProjectId(
  containerId: string | null,
  labels?: Record<string, string> | null,
): number | null {
  const labeled = labels?.[LABEL_PROJECT_ID];
  if (labeled !== undefined) {
    const id = Number(labeled);
    if (Number.isInteger(id) && id > 0) {
      const row = db.query("SELECT id FROM projects WHERE id = ?").get(id) as { id: number } | null;
      if (row) return row.id;
    }
  }
  if (containerId) {
    const row = db.query("SELECT id FROM projects WHERE container_id = ?").get(containerId) as {
      id: number;
    } | null;
    if (row) return row.id;
  }
  return null;
}
