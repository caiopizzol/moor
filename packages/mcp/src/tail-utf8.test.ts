import { describe, expect, test } from "bun:test";
import { tailUtf8 } from "./tail-utf8";

describe("tailUtf8", () => {
  test("returns the string unchanged when under maxBytes", () => {
    const r = tailUtf8("hello", 100);
    expect(r.tail).toBe("hello");
    expect(r.storedBytes).toBe(5);
    expect(r.trimmed).toBe(false);
  });

  test("returns the last maxBytes bytes for ASCII input", () => {
    const r = tailUtf8("0123456789", 4);
    expect(r.tail).toBe("6789");
    expect(r.storedBytes).toBe(10);
    expect(r.trimmed).toBe(true);
  });

  test("returns an empty string when maxBytes is 0", () => {
    const r = tailUtf8("hello", 0);
    expect(r.tail).toBe("");
    expect(r.storedBytes).toBe(5);
    expect(r.trimmed).toBe(true);
  });

  test("preserves complete trailing multi-byte codepoints", () => {
    // "café" = c(1) a(1) f(1) é(2) = 5 bytes. Cap at 4 → trim "c", landing
    // on "a" boundary; result "afé" (4 bytes).
    const r = tailUtf8("café", 4);
    expect(r.tail).toBe("afé");
    expect(r.storedBytes).toBe(5);
    expect(r.trimmed).toBe(true);
    expect(r.tail).not.toContain("\ufffd");
  });

  test("aligns to a codepoint boundary when the cut falls inside a 2-byte sequence", () => {
    // "héllo" = h(1) é(2) l(1) l(1) o(1) = 6 bytes. Cap at 4 → start at
    // byte 2, which is the continuation of é. Align forward to "llo" (3 bytes).
    const r = tailUtf8("héllo", 4);
    expect(r.tail).toBe("llo");
    expect(r.storedBytes).toBe(6);
    expect(r.tail).not.toContain("\ufffd");
  });

  test("aligns to a codepoint boundary inside a 3-byte sequence", () => {
    // "€€€" = 9 bytes (each € = 3 bytes). Cap at 4 → start at byte 5, which
    // is a continuation. Align forward to start of last € → "€" (3 bytes).
    const r = tailUtf8("€€€", 4);
    expect(r.tail).toBe("€");
    expect(r.storedBytes).toBe(9);
    expect(r.tail).not.toContain("\ufffd");
  });

  test("aligns inside a 4-byte sequence (surrogate pair codepoint)", () => {
    // "🌍🌍" = 8 bytes (each emoji = 4 bytes). Cap at 5 → start at byte 3,
    // continuation. Align forward to start of last emoji → "🌍" (4 bytes).
    const r = tailUtf8("🌍🌍", 5);
    expect(r.tail).toBe("🌍");
    expect(r.storedBytes).toBe(8);
    expect(r.tail).not.toContain("\ufffd");
  });

  test("reports storedBytes as the original UTF-8 byte length, not JS char length", () => {
    // "🌍" is 1 codepoint but 4 UTF-8 bytes (and 2 UTF-16 code units in JS).
    const r = tailUtf8("🌍", 100);
    expect(r.storedBytes).toBe(4);
    expect(r.tail.length).toBe(2); // JS string length counts UTF-16 code units
  });
});
