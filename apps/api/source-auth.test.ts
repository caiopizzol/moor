import { describe, expect, test } from "bun:test";
import { deriveSecretKind, normalizeHostname } from "./source-auth";

describe("deriveSecretKind", () => {
  test("ghp_ prefix yields github_classic_pat", () => {
    expect(deriveSecretKind("ghp_abc123")).toBe("github_classic_pat");
  });

  test("github_pat_ prefix yields github_fine_grained_pat", () => {
    expect(deriveSecretKind("github_pat_11ABCD")).toBe("github_fine_grained_pat");
  });

  test("unknown prefix yields unknown", () => {
    expect(deriveSecretKind("hunter2")).toBe("unknown");
    expect(deriveSecretKind("")).toBe("unknown");
    expect(deriveSecretKind("glpat_x")).toBe("unknown");
  });
});

describe("normalizeHostname", () => {
  test("lowercases and trims", () => {
    expect(normalizeHostname("GITHUB.COM")).toBe("github.com");
    expect(normalizeHostname("  github.com  ")).toBe("github.com");
    expect(normalizeHostname("github.example.com")).toBe("github.example.com");
  });
});
