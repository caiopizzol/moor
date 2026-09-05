process.env.MOOR_DB_PATH = ":memory:";

import { afterEach, beforeEach, expect, test } from "bun:test";

const { default: db } = await import("../db");
const { enableDrain, disableDrain } = await import("../drain");
const { handleServer } = await import("./server");

beforeEach(() => disableDrain());
afterEach(() => disableDrain());

async function enable(body: string) {
  const req = new Request("http://localhost/api/server/drain/enable", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const response = await handleServer(req, new URL(req.url));
  if (!response) throw new Error("route missing");
  return response;
}

test("invalid drain bodies cannot enable or overwrite drain", async () => {
  for (const active of [false, true]) {
    if (active) enableDrain({ reason: "existing", ttl_minutes: 10 });
    const before = db.query("SELECT * FROM drain_state").all();
    for (const body of [
      "",
      '{"reason":',
      "null",
      "[]",
      "42",
      ...[
        { reason: 42 },
        { reason: {} },
        { reason: null },
        { clear_after_version: false },
        { clear_after_version: null },
        { ttl_minutes: "5" },
        { ttl_minutes: null },
        { ttl_minutes: {} },
      ].map((body) => JSON.stringify(body)),
      '{"ttl_minutes":1e999}',
    ]) {
      const response = await enable(body);
      expect(response.status).toBe(400);
      expect(typeof (await response.json()).error).toBe("string");
      expect(db.query("SELECT * FROM drain_state").all()).toEqual(before);
    }
  }
});

test("valid drain requests retain defaults and TTL clamping", async () => {
  for (const [ttl, expected] of [
    [undefined, 30],
    [-1, 0.05],
    [99999, 10080],
    [5, 5],
  ] as const) {
    const response = await enable(
      JSON.stringify({ reason: "maintenance", clear_after_version: "1.2.3", ttl_minutes: ttl }),
    );
    expect(response.status).toBe(200);
    const { state } = await response.json();
    expect(state).toMatchObject({
      enabled: true,
      reason: "maintenance",
      clear_after_version: "1.2.3",
    });
    expect(Date.parse(state.expires_at) - Date.parse(state.started_at)).toBe(expected * 60000);
  }
});
