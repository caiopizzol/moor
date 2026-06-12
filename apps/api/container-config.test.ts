// Unit tests for the centralized validation/serialization of declarative
// container config: command/entrypoint overrides and injected file specs. These
// are the rules every write goes through, so they're pinned directly.

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_FILE_MODE,
  MAX_ARGV_ITEMS,
  MAX_FILE_CONTENT_BYTES,
  parseFileMode,
  parseStringArray,
  resolveFileContent,
  resolveFiles,
  serializeStringArray,
  validateFileContent,
  validateFileMode,
  validateFilePath,
  validateStringArray,
} from "./container-config";

// --- command / entrypoint ---

describe("validateStringArray", () => {
  test("null/undefined are allowed (means: image default)", () => {
    expect(validateStringArray(null, "command")).toBeNull();
    expect(validateStringArray(undefined, "command")).toBeNull();
  });

  test("a valid string array passes", () => {
    expect(validateStringArray(["tunnel", "run"], "command")).toBeNull();
    expect(validateStringArray([], "command")).toBeNull();
  });

  test("non-array is rejected, message names the field", () => {
    expect(validateStringArray("tunnel run", "command")).toBe(
      "command must be an array of strings",
    );
    expect(validateStringArray({}, "entrypoint")).toContain("entrypoint");
  });

  test("non-string entries are rejected", () => {
    expect(validateStringArray(["ok", 5], "command")).toBe("command entries must all be strings");
  });

  test("too many items rejected", () => {
    const big = Array.from({ length: MAX_ARGV_ITEMS + 1 }, () => "x");
    expect(validateStringArray(big, "command")).toContain(`at most ${MAX_ARGV_ITEMS}`);
  });

  test("over-long entry rejected", () => {
    expect(validateStringArray(["a".repeat(5000)], "command")).toContain("at most");
  });
});

describe("serializeStringArray", () => {
  test("a non-empty array becomes JSON text", () => {
    expect(serializeStringArray(["tunnel", "run"])).toBe('["tunnel","run"]');
  });

  test("empty array → null (never clears the image default by accident)", () => {
    expect(serializeStringArray([])).toBeNull();
  });

  test("null/undefined/non-array → null", () => {
    expect(serializeStringArray(null)).toBeNull();
    expect(serializeStringArray(undefined)).toBeNull();
    expect(serializeStringArray("x")).toBeNull();
  });
});

describe("parseStringArray", () => {
  test("round-trips a serialized array", () => {
    expect(parseStringArray(serializeStringArray(["a", "b"]))).toEqual(["a", "b"]);
  });

  test("null/empty stored value → null", () => {
    expect(parseStringArray(null)).toBeNull();
    expect(parseStringArray("")).toBeNull();
  });

  test("malformed or non-string-array JSON → null (a bad row can't crash a start)", () => {
    expect(parseStringArray("not json")).toBeNull();
    expect(parseStringArray("[1,2,3]")).toBeNull();
    expect(parseStringArray("[]")).toBeNull();
    expect(parseStringArray('{"a":1}')).toBeNull();
  });
});

// --- file specs ---

describe("validateFilePath", () => {
  test("accepts an absolute printable path", () => {
    expect(validateFilePath("/etc/ssl/cert.pem")).toBeNull();
  });

  test("rejects empty / non-string / relative / directory", () => {
    expect(validateFilePath("")).toContain("required");
    expect(validateFilePath(42)).toContain("required");
    expect(validateFilePath("etc/x")).toContain("absolute");
    expect(validateFilePath("/etc/")).toContain("directory");
  });

  test("rejects whitespace, non-ASCII, and traversal", () => {
    expect(validateFilePath("/etc/a b")).toContain("whitespace");
    expect(validateFilePath("/etc/café")).toContain("ASCII");
    expect(validateFilePath("/etc/../secret")).toContain("..");
  });

  test("rejects rootfs and kernel virtual filesystems", () => {
    // "/" is rejected too, but by the directory rule (trailing slash), which
    // fires before the rootfs check — either way it never reaches the tar.
    expect(validateFilePath("/")).not.toBeNull();
    expect(validateFilePath("/proc")).toContain("critical");
    expect(validateFilePath("/proc/1/mem")).toContain("/proc/");
    expect(validateFilePath("/sys/x")).toContain("/sys/");
    expect(validateFilePath("/dev/null")).toContain("/dev/");
  });
});

describe("validateFileMode", () => {
  test("null/undefined allowed (caller applies the default)", () => {
    expect(validateFileMode(null)).toBeNull();
    expect(validateFileMode(undefined)).toBeNull();
  });

  test("accepts 3- and 4-digit octal forms", () => {
    expect(validateFileMode("600")).toBeNull();
    expect(validateFileMode("0600")).toBeNull();
    expect(validateFileMode("0644")).toBeNull();
  });

  test("rejects non-octal / wrong shape", () => {
    expect(validateFileMode("999")).toContain("octal");
    expect(validateFileMode("rwx")).toContain("octal");
    expect(validateFileMode(420)).toContain("octal");
  });
});

describe("parseFileMode", () => {
  test("parses octal text to bits", () => {
    expect(parseFileMode("0600")).toBe(0o600);
    expect(parseFileMode("600")).toBe(0o600);
    expect(parseFileMode(DEFAULT_FILE_MODE)).toBe(0o644);
  });
});

describe("validateFileContent", () => {
  test("exactly one of content or env_ref is required", () => {
    expect(validateFileContent(undefined, undefined)).toContain("exactly one");
    expect(validateFileContent("inline", "ENV")).toContain("exactly one");
    expect(validateFileContent("inline", undefined)).toBeNull();
    expect(validateFileContent(undefined, "ENV")).toBeNull();
  });

  test("content must be a string and within the size cap", () => {
    expect(validateFileContent(123, undefined)).toContain("string");
    const tooBig = "a".repeat(MAX_FILE_CONTENT_BYTES + 1);
    expect(validateFileContent(tooBig, undefined)).toContain("at most");
  });
});

describe("resolveFileContent", () => {
  test("inline content is returned verbatim", () => {
    expect(resolveFileContent({ path: "/a", content: "hello", env_ref: null }, [])).toBe("hello");
  });

  test("env_ref is sourced from the project env list", () => {
    const envs = [{ key: "TLS_KEY", value: "PEMDATA" }];
    expect(resolveFileContent({ path: "/k", content: null, env_ref: "TLS_KEY" }, envs)).toBe(
      "PEMDATA",
    );
  });

  test("a missing env_ref fails loudly (no silent empty content)", () => {
    expect(() => resolveFileContent({ path: "/k", content: null, env_ref: "ABSENT" }, [])).toThrow(
      'references env var "ABSENT"',
    );
  });
});

describe("resolveFiles", () => {
  test("maps specs to write-ready files (resolved content + numeric mode)", () => {
    const specs = [
      { id: 1, path: "/a.conf", content: "A", env_ref: null, mode: "0644" },
      { id: 2, path: "/b.key", content: null, env_ref: "B_KEY", mode: "0600" },
    ];
    const resolved = resolveFiles(specs, [{ key: "B_KEY", value: "BVAL" }]);
    expect(resolved).toEqual([
      { path: "/a.conf", content: "A", mode: 0o644 },
      { path: "/b.key", content: "BVAL", mode: 0o600 },
    ]);
  });
});
