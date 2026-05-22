import { describe, expect, test } from "bun:test";
import { TailBuffer } from "./output-cap";

const enc = new TextEncoder();

describe("TailBuffer", () => {
  test("preserves the full output when under cap", () => {
    const b = new TailBuffer(64);
    b.appendBytes(enc.encode("hello "));
    b.appendBytes(enc.encode("world"));
    expect(b.tail).toBe("hello world");
    expect(b.totalBytes).toBe(11);
  });

  test("keeps the last N bytes when output exceeds cap", () => {
    const b = new TailBuffer(8);
    b.appendBytes(enc.encode("0123456789ABCDEF"));
    expect(b.tail).toBe("89ABCDEF");
    expect(b.totalBytes).toBe(16);
  });

  test("incoming chunk larger than cap is truncated to its own tail", () => {
    const b = new TailBuffer(4);
    b.appendBytes(enc.encode("1234567890"));
    expect(b.tail).toBe("7890");
    expect(b.totalBytes).toBe(10);
  });

  test("never returns a string starting with a UTF-8 continuation byte", () => {
    const b = new TailBuffer(5);
    // "héllo" — é is 0xC3 0xA9 (2 bytes). Total: h(1) é(2) l(1) l(1) o(1) = 6 bytes.
    // Cap is 5, so we drop the leading "h" → first byte is 0xC3, fine.
    b.appendBytes(enc.encode("héllo"));
    expect(b.tail).toBe("éllo");
    expect(b.totalBytes).toBe(6);
  });

  test("trim aligns to UTF-8 codepoint boundary when cut mid-sequence", () => {
    const b = new TailBuffer(4);
    // "héllo" is 6 bytes: 68 c3 a9 6c 6c 6f. Cap 4 drops 2 bytes → buf starts
    // at 0xa9 (continuation). Aligner should advance past it, leaving "llo".
    b.appendBytes(enc.encode("héllo"));
    expect(b.tail).toBe("llo");
    expect(b.totalBytes).toBe(6);
    // No replacement character at the head
    expect(b.tail.charCodeAt(0)).not.toBe(0xfffd);
  });

  test("appends across many small chunks remain bounded by cap", () => {
    const b = new TailBuffer(16);
    for (let i = 0; i < 1000; i++) b.appendBytes(enc.encode("ab"));
    expect(b.tail.length).toBeLessThanOrEqual(16);
    expect(b.tail).toBe("abababababababab");
    expect(b.totalBytes).toBe(2000);
  });

  test("tracks total bytes correctly regardless of truncation", () => {
    const b = new TailBuffer(4);
    b.appendBytes(enc.encode("abc"));
    b.appendBytes(enc.encode("def"));
    b.appendBytes(enc.encode("ghi"));
    expect(b.totalBytes).toBe(9);
    expect(b.tail).toBe("fghi");
  });

  test("default cap is 64 KiB", () => {
    const b = new TailBuffer();
    const big = new Uint8Array(100_000).fill(0x41); // 'A' * 100k
    b.appendBytes(big);
    expect(b.tailBytes).toBe(64 * 1024);
    expect(b.totalBytes).toBe(100_000);
  });

  // End-trim — a streamed chunk can arrive with only the leading byte of a
  // multi-byte UTF-8 codepoint. Decoding the buffer as-is would emit U+FFFD
  // at the tail end, visible to operators polling moor_exec_status mid-run.
  test("trims an incomplete trailing 2-byte sequence", () => {
    const b = new TailBuffer(16);
    b.appendBytes(enc.encode("ok"));
    b.appendBytes(new Uint8Array([0xc3])); // lead byte of é, no continuation yet
    expect(b.tail).toBe("ok");
    expect(b.tail).not.toContain("\ufffd");
    // Once the continuation arrives, the codepoint completes
    b.appendBytes(new Uint8Array([0xa9])); // continuation of é
    expect(b.tail).toBe("oké");
  });

  test("trims an incomplete trailing 3-byte sequence", () => {
    const b = new TailBuffer(16);
    b.appendBytes(enc.encode("hi "));
    // € is 0xE2 0x82 0xAC. Send only the first two bytes.
    b.appendBytes(new Uint8Array([0xe2, 0x82]));
    expect(b.tail).toBe("hi ");
    expect(b.tail).not.toContain("\ufffd");
    b.appendBytes(new Uint8Array([0xac]));
    expect(b.tail).toBe("hi €");
  });

  test("trims an incomplete trailing 4-byte sequence", () => {
    const b = new TailBuffer(16);
    b.appendBytes(enc.encode("hi "));
    // 🌍 is 0xF0 0x9F 0x8C 0x8D. Send only the first three bytes.
    b.appendBytes(new Uint8Array([0xf0, 0x9f, 0x8c]));
    expect(b.tail).toBe("hi ");
    b.appendBytes(new Uint8Array([0x8d]));
    expect(b.tail).toBe("hi 🌍");
  });

  test("keeps a complete trailing multi-byte codepoint", () => {
    const b = new TailBuffer(16);
    b.appendBytes(enc.encode("café"));
    // é is a complete 2-byte sequence — should be included
    expect(b.tail).toBe("café");
  });
});
