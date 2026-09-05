process.env.MOOR_DB_PATH = ":memory:";

import { beforeEach, expect, test } from "bun:test";
import type { CleanupScope, ExecuteCandidate } from "../cleanup";

const { handleCleanup } = await import("./cleanup");
const { readJsonObject } = await import("../http");
const planned: CleanupScope[][] = [];
const executed: ExecuteCandidate[][] = [];
const operations = {
  async plan(scope: CleanupScope[]) {
    planned.push(scope);
    return { candidates: [], total_reclaimable_bytes: 0 };
  },
  async execute(candidates: ExecuteCandidate[]) {
    executed.push(candidates);
    return { audit_id: 1, results: [], total_reclaimed_bytes: 0 };
  },
};
beforeEach(() => {
  planned.length = 0;
  executed.length = 0;
});
async function request(verb: string, body?: string) {
  const req = new Request(`http://localhost/api/server/cleanup/${verb}`, {
    method: "POST",
    ...(body === undefined ? {} : { body }),
  });
  const response = await handleCleanup(req, new URL(req.url), operations);
  if (!response) throw new Error("missing route");
  return response;
}

test("cleanup routes reject JSON null rather than throwing", async () => {
  for (const verb of ["plan", "execute"]) {
    expect((await request(verb, "null")).status).toBe(400);
  }
  expect(planned).toEqual([]);
  expect(executed).toEqual([]);
});

test("cleanup rejects malformed and nonobject bodies before any operation", async () => {
  for (const verb of ["plan", "execute"]) {
    for (const body of [" ", "{", "[]", "42", "true", '"text"']) {
      const response = await request(verb, body);
      expect(response.status).toBe(400);
      expect(typeof (await response.json()).error).toBe("string");
    }
  }
  expect(planned).toEqual([]);
  expect(executed).toEqual([]);
});

test("cleanup retains bodyless and explicit field defaults for plan", async () => {
  for (const body of [undefined, "", "{}", '{"scope":null}', '{"scope":[]}']) {
    expect((await request("plan", body)).status).toBe(200);
  }
  expect(planned).toEqual(Array(5).fill(["build_cache", "dangling_image"]));
  expect((await request("plan", '{"scope":["dangling_image"]}')).status).toBe(200);
  expect(planned.at(-1)).toEqual(["dangling_image"]);
  expect(executed).toEqual([]);
});

test("cleanup retains execute candidate validation and strips metadata", async () => {
  for (const body of [
    undefined,
    "{}",
    '{"candidates":[]}',
    '{"candidates":[{"category":"volume"}]}',
  ]) {
    expect((await request("execute", body)).status).toBe(400);
  }
  expect(executed).toEqual([]);
  const response = await request(
    "execute",
    JSON.stringify({
      candidates: [
        { category: "build_cache", label: "caution", reclaimable_bytes: 9 },
        { category: "dangling_image", id: "sha256:test", label: "safe", repo_tags: [] },
      ],
    }),
  );
  expect(response.status).toBe(200);
  expect(executed).toEqual([
    [{ category: "build_cache" }, { category: "dangling_image", id: "sha256:test" }],
  ]);
  expect(planned).toEqual([]);
});

test("cleanup rejects invalid scope without planning", async () => {
  expect((await request("plan", '{"scope":["volume"]}')).status).toBe(400);
  expect(planned).toEqual([]);
  expect(executed).toEqual([]);
});

test("cleanup accepts empty network plan bodies including streamed bodies", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      return (
        (await handleCleanup(req, new URL(req.url), operations)) ??
        new Response(null, { status: 404 })
      );
    },
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
      const response = await fetch(new URL("/api/server/cleanup/plan", server.url), {
        method: "POST",
        body,
      });
      expect(response.status).toBe(200);
      await response.text();
    }
    expect(planned).toEqual(Array(3).fill(["build_cache", "dangling_image"]));
    expect(executed).toEqual([]);
    const emptyExecute = await fetch(new URL("/api/server/cleanup/execute", server.url), {
      method: "POST",
      body: new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
    });
    expect(emptyExecute.status).toBe(400);
    expect(await emptyExecute.json()).toEqual({ error: "candidates must be an array" });
    const malformed = await fetch(new URL("/api/server/cleanup/plan", server.url), {
      method: "POST",
      body: "{",
    });
    expect(malformed.status).toBe(400);
    await malformed.text();
    expect(planned).toHaveLength(3);
    expect(executed).toEqual([]);
  } finally {
    await server.stop(true);
  }
});

test("JSON object reader remains strict unless empty content is explicitly allowed", async () => {
  for (const body of [undefined, "", " ", "null", "[]", "{"]) {
    const req = new Request("http://localhost/", { method: "POST", body });
    const result = await readJsonObject(req);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(400);
  }
  const valid = await readJsonObject(
    new Request("http://localhost/", { method: "POST", body: '{"a":1}' }),
  );
  expect(valid).toEqual({ ok: true, value: { a: 1 } });
});
