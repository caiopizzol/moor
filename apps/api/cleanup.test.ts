// Unit tests for #54 pure helpers. The Docker fetch / execute glue is
// exercised via live smoke after deploy; mocking the engine round-trip
// here would test the test setup more than the cleanup contract.

process.env.MOOR_DB_PATH = ":memory:";

import { beforeEach, describe, expect, test } from "bun:test";

const { default: db } = await import("./db");
const {
  executeCleanup: _execute,
  summarizeBuildCachePlan,
  summarizeDanglingImagesPlan,
  validateExecuteCandidates,
  validateScope,
} = await import("./cleanup");

describe("#54 validateScope", () => {
  test("defaults to the full v1 scope when undefined", () => {
    const v = validateScope(undefined);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.value).toEqual(["build_cache", "dangling_image"]);
  });

  test("accepts a subset and de-duplicates", () => {
    const v = validateScope(["dangling_image", "dangling_image"]);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.value).toEqual(["dangling_image"]);
  });

  test("empty array falls back to default scope (not 'do nothing')", () => {
    const v = validateScope([]);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.value).toEqual(["build_cache", "dangling_image"]);
  });

  test("rejects unknown scope tokens — v2 categories should not slip in", () => {
    const v = validateScope(["orphan_moor_volume"]);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain("v1 supports");
  });
});

describe("#54 validateExecuteCandidates — strips caller metadata to identifiers", () => {
  test("keeps category + id; drops reclaimable_bytes, label, etc.", () => {
    const v = validateExecuteCandidates([
      { category: "build_cache", reclaimable_bytes: 999_999, label: "caution" },
      { category: "dangling_image", id: "sha256:abc", reclaimable_bytes: 123, repo_tags: ["x"] },
    ]);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.value).toEqual([
        { category: "build_cache" },
        { category: "dangling_image", id: "sha256:abc" },
      ]);
    }
  });

  test("rejects dangling_image without id", () => {
    const v = validateExecuteCandidates([{ category: "dangling_image" }]);
    expect(v.ok).toBe(false);
  });

  test("rejects unknown category", () => {
    const v = validateExecuteCandidates([{ category: "orphan_moor_volume", docker_name: "x" }]);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain("unknown candidate category");
  });

  test("rejects non-array input", () => {
    expect(validateExecuteCandidates(null).ok).toBe(false);
    expect(validateExecuteCandidates({}).ok).toBe(false);
    expect(validateExecuteCandidates("nope").ok).toBe(false);
  });

  test("rejects empty array — no silent no-op audit row", () => {
    const v = validateExecuteCandidates([]);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain("must not be empty");
  });
});

describe("#54 summarizeBuildCachePlan", () => {
  test("returns one row with reclaimable bytes when there's something to free", () => {
    const row = summarizeBuildCachePlan({
      BuildCache: [
        { ID: "a", Size: 1000, InUse: true, Shared: false },
        { ID: "b", Size: 500, InUse: false, Shared: false },
        { ID: "c", Size: 250, InUse: false, Shared: true },
      ],
    });
    expect(row).not.toBeNull();
    if (!row) return;
    expect(row.category).toBe("build_cache");
    expect(row.reclaimable_bytes).toBe(500);
    expect(row.label).toBe("caution");
  });

  test("returns null when there's nothing safely reclaimable — no useless candidate", () => {
    const row = summarizeBuildCachePlan({
      BuildCache: [{ ID: "a", Size: 1000, InUse: true, Shared: false }],
    });
    expect(row).toBeNull();
  });
});

describe("#54 summarizeDanglingImagesPlan", () => {
  test("emits one safe candidate per image with unique-bytes reclaimable", () => {
    const out = summarizeDanglingImagesPlan([
      { Id: "sha256:a", Size: 1000, SharedSize: 200, RepoTags: ["<none>:<none>"] },
      { Id: "sha256:b", Size: 500, SharedSize: 100, RepoTags: null },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      category: "dangling_image",
      id: "sha256:a",
      reclaimable_bytes: 800,
      repo_tags: ["<none>:<none>"],
      label: "safe",
    });
    const second = out[1];
    expect(second.category).toBe("dangling_image");
    if (second.category !== "dangling_image") throw new Error("unreachable");
    expect(second.repo_tags).toEqual([]);
  });

  test("skips images with zero unique bytes — no candidate the caller can't free", () => {
    const out = summarizeDanglingImagesPlan([
      { Id: "sha256:c", Size: 300, SharedSize: 300, RepoTags: null },
    ]);
    expect(out).toHaveLength(0);
  });
});

describe("#54 cleanup_audit table exists and is writable", () => {
  beforeEach(() => {
    db.query("DELETE FROM cleanup_audit").run();
  });

  test("schema accepts the audit shape executeCleanup writes", () => {
    db.query(
      "INSERT INTO cleanup_audit (candidates_json, results_json, reclaimed_bytes) VALUES (?, ?, ?)",
    ).run("[]", "[]", 0);
    const row = db.query("SELECT * FROM cleanup_audit LIMIT 1").get() as {
      id: number;
      candidates_json: string;
      reclaimed_bytes: number;
      executed_at: string;
    };
    expect(row.id).toBeGreaterThan(0);
    expect(row.candidates_json).toBe("[]");
    expect(row.reclaimed_bytes).toBe(0);
    expect(row.executed_at).toBeDefined();
  });
});
