// #131 subsystem 5: Docker /events consumer — the primary, high-fidelity
// source of lifecycle events. A 30s poll structurally cannot see short-lived
// states (a container that OOM-kills and is restarted by its policy within the
// window looks "running" at both samples); the event stream pushes die/oom/
// kill/start as they happen. The status reconciler's poll edges remain the
// backstop for whatever the stream misses.
//
// Fidelity caveats handled here:
//  - Replays: a reconnect re-reads with `since`, so the same event can arrive
//    twice. appendProjectEvent dedups on (container_id, action, time_nano).
//  - In-process gaps: if a reconnect lands long after the last event (daemon
//    restart, network outage while moor stays up), a docker_event_gap marker
//    is recorded so the history reader knows events may be missing.
//  - Boot gaps: on a fresh start we connect without `since` (only new events),
//    so events during moor downtime are not recovered. That window is already
//    visible elsewhere (process restart, the absence of resource samples), so
//    we don't synthesize a boot gap to avoid a marker on every normal restart.
//  - Pre-label containers: the stream is filtered to containers carrying the
//    sh.moor.project_id label, so containers created before labels shipped
//    won't appear until recreated. Accepted transitional gap (see #131).

import { LABEL_PROJECT_ID, SOCKET as SOCKET_PATH } from "./docker";
import { resolveProjectId } from "./project-correlation";
import { appendProjectEvent } from "./project-events";

// Container lifecycle actions worth recording. Deliberately excludes the noisy
// exec_*/attach/top/etc. actions. `oom` is the authoritative OOM signal — we
// never infer OOM from an exit code.
const RECORDED_ACTIONS = new Set([
  "create",
  "start",
  "restart",
  "kill",
  "die",
  "oom",
  "stop",
  "destroy",
]);

export type NormalizedDockerEvent = {
  action: string;
  containerId: string;
  // Actor.Attributes: container labels merged with event attributes (image,
  // name, exitCode, ...). Carries sh.moor.project_id for labeled containers.
  attributes: Record<string, string>;
  timeNano: number;
  raw: unknown;
};

/** Pure: validate and reduce a raw Docker event to the fields we persist, or
 *  null for events we ignore (non-container, non-recorded action, malformed).
 *  health_status arrives as "health_status: healthy" — we key on the head. */
export function normalizeDockerEvent(raw: unknown): NormalizedDockerEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const ev = raw as {
    Type?: unknown;
    Action?: unknown;
    Actor?: { ID?: unknown; Attributes?: unknown };
    time?: unknown;
    timeNano?: unknown;
  };
  if (ev.Type !== "container") return null;
  const action = typeof ev.Action === "string" ? ev.Action.split(":")[0].trim() : "";
  if (!RECORDED_ACTIONS.has(action)) return null;
  const containerId = ev.Actor?.ID;
  if (typeof containerId !== "string" || containerId === "") return null;
  const attributes =
    typeof ev.Actor?.Attributes === "object" && ev.Actor.Attributes !== null
      ? (ev.Actor.Attributes as Record<string, string>)
      : {};
  const timeNano = Number(ev.timeNano ?? 0);
  return {
    action,
    containerId,
    attributes,
    timeNano: Number.isFinite(timeNano) ? timeNano : 0,
    raw,
  };
}

/** Correlate a raw Docker event to a project and append it. Returns true if a
 *  row was inserted (false: ignored, uncorrelated, or deduped). */
export function ingestDockerEvent(raw: unknown): boolean {
  const ev = normalizeDockerEvent(raw);
  if (!ev) return false;
  const projectId = resolveProjectId(ev.containerId, ev.attributes);
  // Require a project: keeps the log to moor's own containers and avoids
  // FK-null rows for unrelated container churn. The label filter on the stream
  // means this is rarely null in practice.
  if (projectId === null) return false;
  return appendProjectEvent({
    projectId,
    containerId: ev.containerId,
    source: "docker_event",
    action: ev.action,
    occurredAtMs: ev.timeNano > 0 ? Math.floor(ev.timeNano / 1e6) : Date.now(),
    timeNano: ev.timeNano > 0 ? ev.timeNano : null,
    raw: ev.raw,
  });
}

/** Pure: decide whether a reconnect should record a gap marker. No gap on the
 *  first connect (lastSeenMs null). Below the threshold, the `since` overlap
 *  plus Docker's backlog almost certainly covered the blip. */
export function shouldRecordGap(
  lastSeenMs: number | null,
  reconnectMs: number,
  thresholdMs: number,
): boolean {
  if (lastSeenMs === null) return false;
  return reconnectMs - lastSeenMs > thresholdMs;
}

const FILTERS = JSON.stringify({ type: ["container"], label: [LABEL_PROJECT_ID] });
const OVERLAP_SEC = 5; // re-read a few seconds before the last event on reconnect
const GAP_THRESHOLD_MS = 30_000;
const RECONNECT_BACKOFF_MS = 3_000;

let abort: AbortController | null = null;
let stopped = false;
let lastEventSec: number | null = null;
let lastSeenMs: number | null = null;

export function startDockerEventConsumer(): void {
  stopped = false;
  lastEventSec = null;
  lastSeenMs = null;
  console.log("[docker-events] enabled: streaming container lifecycle events");
  void consumeLoop();
}

export function stopDockerEventConsumer(): void {
  stopped = true;
  abort?.abort();
}

async function consumeLoop(): Promise<void> {
  while (!stopped) {
    const nowMs = Date.now();
    if (shouldRecordGap(lastSeenMs, nowMs, GAP_THRESHOLD_MS)) {
      appendProjectEvent({
        projectId: null,
        containerId: null,
        source: "docker_event",
        action: "docker_event_gap",
        occurredAtMs: nowMs,
        raw: { from_ms: lastSeenMs, to_ms: nowMs },
      });
    }
    abort = new AbortController();
    try {
      const sinceParam = lastEventSec !== null ? `&since=${lastEventSec - OVERLAP_SEC}` : "";
      const res = await fetch(
        `http://localhost/v1.44/events?filters=${encodeURIComponent(FILTERS)}${sinceParam}`,
        { unix: SOCKET_PATH, signal: abort.signal },
      );
      if (!res.ok || !res.body) {
        console.warn(`[docker-events] connect failed (${res.status}); retrying`);
      } else {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (!stopped) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl = buf.indexOf("\n");
          while (nl >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (line) {
              let parsed: unknown;
              try {
                parsed = JSON.parse(line);
              } catch {
                parsed = null;
              }
              if (parsed) {
                ingestDockerEvent(parsed);
                const t = Number((parsed as { time?: unknown }).time);
                if (Number.isFinite(t) && t > 0) lastEventSec = t;
                lastSeenMs = Date.now();
              }
            }
            nl = buf.indexOf("\n");
          }
        }
      }
    } catch {
      // Aborted on shutdown, or a network/daemon error — fall through to retry.
    }
    if (stopped) break;
    await new Promise((r) => setTimeout(r, RECONNECT_BACKOFF_MS));
  }
}
