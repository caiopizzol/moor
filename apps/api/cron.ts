import db from "./db";
import { execInContainer } from "./docker";

type CronRow = {
  id: number;
  project_id: number;
  name: string;
  schedule: string;
  command: string;
  enabled: number;
};

type ProjectRow = {
  id: number;
  container_id: string | null;
  status: string;
};

function matchesCron(schedule: string, date: Date): boolean {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  const [minPat, hourPat, domPat, monPat, dowPat] = parts;
  const minute = date.getMinutes();
  const hour = date.getHours();
  const dom = date.getDate();
  const month = date.getMonth() + 1;
  const dow = date.getDay(); // 0=Sunday

  return (
    matchField(minPat, minute, 0, 59) &&
    matchField(hourPat, hour, 0, 23) &&
    matchField(domPat, dom, 1, 31) &&
    matchField(monPat, month, 1, 12) &&
    matchField(dowPat, dow, 0, 6)
  );
}

function matchField(pattern: string, value: number, _min: number, _max: number): boolean {
  if (pattern === "*") return true;

  for (const part of pattern.split(",")) {
    // Handle step: */5 or 1-10/2
    const [rangePart, stepStr] = part.split("/");
    const step = stepStr ? Number(stepStr) : 1;

    if (rangePart === "*") {
      if (value % step === 0) return true;
      continue;
    }

    // Handle range: 1-5
    if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-").map(Number);
      if (value >= a && value <= b && (value - a) % step === 0) return true;
      continue;
    }

    // Exact value
    if (Number(rangePart) === value) return true;
  }

  return false;
}

async function tick() {
  const now = new Date();
  const crons = db.query("SELECT * FROM crons WHERE enabled = 1").all() as CronRow[];

  for (const cron of crons) {
    if (!matchesCron(cron.schedule, now)) continue;

    const project = db
      .query("SELECT id, container_id, status FROM projects WHERE id = ?")
      .get(cron.project_id) as ProjectRow | null;

    if (!project || project.status !== "running" || !project.container_id) continue;

    // Run in background — don't block the tick
    runCron(cron, project.container_id);
  }
}

async function runCron(cron: CronRow, containerId: string) {
  const startedAt = new Date().toISOString();
  const run = db
    .query("INSERT INTO runs (cron_id, project_id, started_at) VALUES (?, ?, ?) RETURNING id")
    .get(cron.id, cron.project_id, startedAt) as { id: number };

  const start = Date.now();

  try {
    const result = await execInContainer(containerId, cron.command);
    const duration = Date.now() - start;

    db.query(
      "UPDATE runs SET finished_at = ?, exit_code = ?, stdout = ?, stderr = ?, duration_ms = ? WHERE id = ?",
    ).run(
      new Date().toISOString(),
      result.exitCode,
      result.stdout,
      result.stderr,
      duration,
      run.id,
    );
  } catch (e) {
    const duration = Date.now() - start;
    const message = e instanceof Error ? e.message : "Unknown error";
    db.query(
      "UPDATE runs SET finished_at = ?, exit_code = -1, stderr = ?, duration_ms = ? WHERE id = ?",
    ).run(new Date().toISOString(), message, duration, run.id);
  }
}

export function startCronScheduler() {
  console.log("[cron] Scheduler started — checking every 60s");
  setInterval(tick, 60_000);
}
