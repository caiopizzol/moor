// Tests for #134: a container that Docker creates but fails to start (or
// network-attach) must be removed, since createAndStartContainer only persists
// container_id after a successful start — otherwise the orphan lingers in
// `Created` state and project delete can't reap it. startOrCleanup holds that
// logic; `start` and `remove` are injected here.

process.env.MOOR_DB_PATH = ":memory:";

import { describe, expect, test } from "bun:test";

const { startOrCleanup } = await import("./docker");

describe("#134 startOrCleanup — orphan cleanup on failed start", () => {
  test("start succeeds → container kept, remove never called", async () => {
    const removed: string[] = [];
    await startOrCleanup(
      "abc123",
      async () => {},
      async (id) => {
        removed.push(id);
      },
    );
    expect(removed).toEqual([]);
  });

  test("start fails → removes the created id, original error rethrown", async () => {
    const removed: string[] = [];
    await expect(
      startOrCleanup(
        "abc123",
        async () => {
          throw new Error("Container start failed: boom");
        },
        async (id) => {
          removed.push(id);
        },
      ),
    ).rejects.toThrow("Container start failed: boom");
    expect(removed).toEqual(["abc123"]);
  });

  test("network connect fails (pre-start) → also removes the created id", async () => {
    const removed: string[] = [];
    await expect(
      startOrCleanup(
        "def456",
        async () => {
          throw new Error("Network connect failed (500): boom");
        },
        async (id) => {
          removed.push(id);
        },
      ),
    ).rejects.toThrow("Network connect failed");
    expect(removed).toEqual(["def456"]);
  });

  test("cleanup remove fails → original start error still wins (not masked)", async () => {
    await expect(
      startOrCleanup(
        "ghi789",
        async () => {
          throw new Error("Container start failed: boom");
        },
        async () => {
          throw new Error("remove exploded");
        },
      ),
    ).rejects.toThrow("Container start failed: boom"); // NOT "remove exploded"
  });
});

// The 4th scenario from #134 — "Docker create fails → no cleanup attempt" — is
// structural, not re-tested here: createAndStartContainer throws at the create
// step (createRes not ok) BEFORE an Id exists, so startOrCleanup is never
// reached and there is no container to remove. Exercising it would require
// mocking the global Docker socket fetch, which this codebase doesn't do for
// createAndStartContainer.
