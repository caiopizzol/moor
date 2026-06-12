// Unit tests for the POSIX ustar tar builder used to inject project files via
// Docker's PUT /containers/{id}/archive endpoint. The header encoding has to be
// exact (mode, size, checksum, magic) or Docker rejects the archive, so these
// assertions pin the on-the-wire bytes.

import { describe, expect, test } from "bun:test";
import { buildTar, splitUstarName } from "./tar";

const BLOCK = 512;

function field(buf: Uint8Array, offset: number, len: number): string {
  let end = offset;
  while (end < offset + len && buf[end] !== 0) end++;
  return new TextDecoder().decode(buf.slice(offset, end));
}

/** Recompute the ustar header checksum (chksum field counted as spaces) and
 *  compare against the value stored in the header. */
function checksumValid(header: Uint8Array): boolean {
  const stored = Number.parseInt(field(header, 148, 8), 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) {
    sum += i >= 148 && i < 156 ? 0x20 : header[i];
  }
  return sum === stored;
}

describe("buildTar", () => {
  test("single regular-file entry: header fields, padding, end-of-archive", () => {
    const tar = buildTar([{ name: "hello.txt", content: "hi", mode: 0o644 }]);

    // header(512) + body padded to 512 + two zero end blocks(1024)
    expect(tar.length).toBe(BLOCK * 4);

    expect(field(tar, 0, 100)).toBe("hello.txt");
    expect(Number.parseInt(field(tar, 100, 8), 8)).toBe(0o644);
    expect(Number.parseInt(field(tar, 124, 12), 8)).toBe(2); // size = "hi"
    expect(tar[156]).toBe(0x30); // typeflag '0' = regular file
    expect(field(tar, 257, 6)).toBe("ustar");
    expect(checksumValid(tar.slice(0, BLOCK))).toBe(true);

    // body sits in the second block and is zero-padded
    expect(field(tar, BLOCK, 2)).toBe("hi");
    expect(tar[BLOCK + 2]).toBe(0);

    // last two blocks are all zero (end-of-archive marker)
    expect(tar.slice(BLOCK * 2).every((b) => b === 0)).toBe(true);
  });

  test("mode 0o600 is written exactly (the TLS-key case)", () => {
    const tar = buildTar([{ name: "key.pem", content: "secret", mode: 0o600 }]);
    expect(Number.parseInt(field(tar, 100, 8), 8)).toBe(0o600);
  });

  test("accepts Uint8Array content and records its byte length", () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const tar = buildTar([{ name: "blob.bin", content: bytes, mode: 0o644 }]);
    expect(Number.parseInt(field(tar, 124, 12), 8)).toBe(5);
  });

  test("multiple entries are emitted in order, each on a block boundary", () => {
    const tar = buildTar([
      { name: "a.conf", content: "AAAA", mode: 0o644 },
      { name: "b.key", content: "BB", mode: 0o600 },
    ]);
    // 2 * (header + padded body) = 4 blocks, + end(1024) = 2 blocks → 6*512
    expect(tar.length).toBe(BLOCK * 6);
    expect(field(tar, 0, 100)).toBe("a.conf");
    expect(field(tar, BLOCK * 2, 100)).toBe("b.key");
    expect(Number.parseInt(field(tar, BLOCK * 2 + 100, 8), 8)).toBe(0o600);
  });

  test("body exactly one block long gets no extra padding", () => {
    const tar = buildTar([{ name: "x", content: "z".repeat(BLOCK), mode: 0o644 }]);
    // header + exactly one body block + end(1024)
    expect(tar.length).toBe(BLOCK * 4);
  });

  test("deterministic: same input → identical bytes (mtime/uid/gid fixed)", () => {
    const a = buildTar([{ name: "f", content: "data", mode: 0o644 }]);
    const b = buildTar([{ name: "f", content: "data", mode: 0o644 }]);
    expect(a).toEqual(b);
  });
});

describe("splitUstarName", () => {
  test("short name goes entirely in the name field", () => {
    expect(splitUstarName("etc/ssl/cert.pem")).toEqual({ name: "etc/ssl/cert.pem", prefix: "" });
  });

  test("long path splits on a slash into name (<=100) + prefix (<=155)", () => {
    const head = "a".repeat(120);
    const tail = "b".repeat(50);
    const split = splitUstarName(`${head}/${tail}`);
    expect(split).toEqual({ name: tail, prefix: head });
  });

  test("a single segment longer than 100 chars cannot be encoded → throws", () => {
    expect(() => splitUstarName("c".repeat(101))).toThrow("too long to encode");
  });
});
