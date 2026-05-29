// Tests for #131 container -> project correlation. Label path is preferred;
// container_id is the fallback for pre-label containers.

process.env.MOOR_DB_PATH = ":memory:";

import { beforeEach, expect, test } from "bun:test";

const { default: db } = await import("./db");
const { resolveProjectId } = await import("./project-correlation");
const { LABEL_PROJECT_ID } = await import("./docker");

function makeProject(name: string, containerId: string | null = null): number {
  const row = db
    .query("INSERT INTO projects (name, container_id) VALUES (?, ?) RETURNING id")
    .get(name, containerId) as { id: number };
  return row.id;
}

beforeEach(() => {
  db.query("DELETE FROM projects").run();
});

test("label path: resolves to the labeled project when it exists", () => {
  const id = makeProject("p1", "cid-1");
  expect(resolveProjectId("cid-1", { [LABEL_PROJECT_ID]: String(id) })).toBe(id);
});

test("label preferred over container_id when both point at different rows", () => {
  const a = makeProject("a", "cid-a");
  const b = makeProject("b", "cid-b");
  // event carries container cid-b but label says project a — label wins
  expect(resolveProjectId("cid-b", { [LABEL_PROJECT_ID]: String(a) })).toBe(a);
  expect(b).not.toBe(a);
});

test("stale label (project gone) falls back to container_id match", () => {
  const id = makeProject("p1", "cid-1");
  expect(resolveProjectId("cid-1", { [LABEL_PROJECT_ID]: "9999" })).toBe(id);
});

test("no label: container_id match (pre-label container)", () => {
  const id = makeProject("p1", "cid-1");
  expect(resolveProjectId("cid-1", undefined)).toBe(id);
  expect(resolveProjectId("cid-1", {})).toBe(id);
});

test("malformed label falls back to container_id", () => {
  const id = makeProject("p1", "cid-1");
  expect(resolveProjectId("cid-1", { [LABEL_PROJECT_ID]: "not-a-number" })).toBe(id);
});

test("returns null when nothing resolves", () => {
  makeProject("p1", "cid-1");
  expect(resolveProjectId("unknown", undefined)).toBeNull();
  expect(resolveProjectId(null, { [LABEL_PROJECT_ID]: "9999" })).toBeNull();
});
