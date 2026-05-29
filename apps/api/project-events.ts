// Project observability history: the single append path for project_events.
// Every lifecycle edge lands here, whatever observed it:
//   - the Docker /events consumer       → source="docker_event"
//   - the status reconciler / live poll → source="poll"
//   - an explicit moor action           → source="moor_action"
//
// docker_event rows carry a non-null time_nano and may be replayed when the
// /events stream reconnects and re-reads its backlog; the
// UNIQUE(container_id, action, time_nano) constraint dedups those (INSERT OR
// IGNORE). poll/action edges pass time_nano = NULL, and SQLite treats NULLs as
// distinct in a UNIQUE index, so every genuine state change is still recorded.

import db from "./db";

export type EventSource = "docker_event" | "poll" | "moor_action";

export type ProjectEventInput = {
  // Nullable because a Docker event can arrive before we've correlated its
  // container back to a project; the consumer backfills project_id when it can.
  projectId: number | null;
  containerId: string | null;
  source: EventSource;
  action: string;
  occurredAtMs: number;
  timeNano?: number | null;
  // Arbitrary provenance payload (e.g. the raw Docker event). Stored as JSON.
  raw?: unknown;
};

/** Append one event. Returns true if a row was inserted, false if the UNIQUE
 *  constraint deduped it (a replayed docker_event). */
export function appendProjectEvent(e: ProjectEventInput): boolean {
  const raw =
    e.raw === undefined || e.raw === null
      ? null
      : typeof e.raw === "string"
        ? e.raw
        : JSON.stringify(e.raw);
  const res = db
    .query(
      `INSERT OR IGNORE INTO project_events
         (project_id, container_id, occurred_at_ms, time_nano, source, action, raw_json, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      e.projectId,
      e.containerId,
      e.occurredAtMs,
      e.timeNano ?? null,
      e.source,
      e.action,
      raw,
      Date.now(),
    );
  return res.changes > 0;
}
