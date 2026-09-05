process.env.MOOR_DB_PATH = ":memory:";

import { beforeEach, expect, test } from "bun:test";
import type { ApplyError, ApplyInput, ApplyResult } from "../update-apply";

const { handleUpdateApply } = await import("./server");
const calls: ApplyInput[] = [];
const digest = `sha256:${"a".repeat(64)}`;
let result: ApplyResult;
const apply = async (input: ApplyInput): Promise<ApplyResult> => {
  calls.push(input);
  return result;
};
beforeEach(() => {
  calls.length = 0;
  result = { ok: true, audit_id: 9 };
});
function request(body?: string) {
  return handleUpdateApply(
    new Request("http://localhost/api/server/update/apply", {
      method: "POST",
      ...(body === undefined ? {} : { body }),
    }),
    apply,
  );
}

test("update apply rejects malformed and nonobject bodies before orchestration", async () => {
  for (const body of ["{", " ", "null", "[]", "42", "true", '"text"']) {
    const response = await request(body);
    expect(response.status).toBe(400);
    expect(typeof (await response.json()).error).toBe("string");
  }
  expect(calls).toEqual([]);
});

test("update apply rejects invalid digest fields before orchestration", async () => {
  for (const value of [
    null,
    42,
    false,
    [],
    {},
    "",
    "latest",
    `sha256:${"A".repeat(64)}`,
    `sha256:${"a".repeat(63)}`,
    `${digest}\n`,
    ` ${digest}`,
  ]) {
    expect((await request(JSON.stringify({ target_digest: value }))).status).toBe(400);
  }
  expect(calls).toEqual([]);
});

test("update apply rejects invalid bypass fields before orchestration", async () => {
  for (const value of [null, 42, {}, "active_work", ["bogus"], [null], ["active_work", 1]]) {
    expect((await request(JSON.stringify({ bypass: value }))).status).toBe(400);
  }
  expect(calls).toEqual([]);
});

test("update apply preserves empty defaults and accepted input while stripping unknown fields", async () => {
  for (const body of [undefined, "", "{}"]) {
    const response = await request(body);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ audit_id: 9 });
  }
  expect(calls).toEqual([{}, {}, {}]);
  const bypassCases: NonNullable<ApplyInput["bypass"]>[] = [
    [],
    ["active_work"],
    ["unknown_digest", "active_work", "active_work"],
  ];
  for (const bypass of bypassCases) {
    expect(
      (await request(JSON.stringify({ target_digest: digest, bypass, extra: true }))).status,
    ).toBe(202);
    expect(calls.at(-1)).toEqual({ target_digest: digest, bypass });
  }
  expect((await request(JSON.stringify({ target_digest: digest }))).status).toBe(202);
  expect(calls.at(-1)).toEqual({ target_digest: digest });
});

test("update apply preserves orchestration error envelopes and status codes", async () => {
  const cases: Array<[ApplyError, number]> = [
    [{ code: "preflight_failed", reason: "unsafe" }, 409],
    [{ code: "context_failed", reason: "missing" }, 412],
    [{ code: "current_image_unknown", reason: "offline" }, 503],
    [{ code: "already_in_progress" }, 409],
    [{ code: "race_active_work", counts: { builds: 1 } }, 409],
    [{ code: "backup_failed", reason: "disk full" }, 500],
    [{ code: "respawner_launch_failed", reason: "offline" }, 500],
  ];
  for (const [error, status] of cases) {
    result = { ok: false, error };
    const response = await request("{}");
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error });
  }
  expect(calls).toHaveLength(cases.length);
});

test("update apply distinguishes empty network streams from invalid bodies", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => handleUpdateApply(req, apply),
  });
  try {
    for (const body of [
      undefined,
      "",
      new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
    ]) {
      const response = await fetch(server.url, { method: "POST", body });
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ audit_id: 9 });
    }
    expect(calls).toEqual([{}, {}, {}]);
    calls.length = 0;
    for (const body of ["{", " ", "null", "[]", "42"]) {
      const response = await fetch(server.url, { method: "POST", body });
      expect(response.status).toBe(400);
      await response.text();
    }
    expect(calls).toEqual([]);
  } finally {
    await server.stop(true);
  }
});
