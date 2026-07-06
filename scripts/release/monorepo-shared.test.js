import { describe, expect, test } from "bun:test";
import { getReleasePaths, isCommitInReleasePaths } from "./monorepo-shared.js";

describe("isCommitInReleasePaths", () => {
  const cliReleasePaths = ["packages/cli", "packages/contract"];

  test("includes commits touching the package directory", () => {
    expect(isCommitInReleasePaths(cliReleasePaths, ["packages/cli/src/index.ts"])).toBe(true);
  });

  test("includes commits touching the shared contract directory", () => {
    expect(isCommitInReleasePaths(cliReleasePaths, ["packages/contract/src/client.ts"])).toBe(true);
  });

  test("excludes commits outside the package and shared paths", () => {
    expect(isCommitInReleasePaths(cliReleasePaths, ["apps/api/index.ts"])).toBe(false);
  });

  test("uses MOOR_RELEASE_SHARED_PATHS as the shared-path override", () => {
    const releasePaths = getReleasePaths("packages/cli", {
      MOOR_RELEASE_SHARED_PATHS: "packages/shared, apps/web",
    });

    expect(isCommitInReleasePaths(releasePaths, ["packages/contract/src/client.ts"])).toBe(false);
    expect(isCommitInReleasePaths(releasePaths, ["packages/shared/index.ts"])).toBe(true);
    expect(isCommitInReleasePaths(releasePaths, ["apps/web/src/main.tsx"])).toBe(true);
  });
});
