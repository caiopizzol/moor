import { describe, expect, test } from "bun:test";
import { createFrameParser } from "./docker-frame-parser";

function frame(streamType: 1 | 2, payload: Uint8Array): Uint8Array {
  const buf = new Uint8Array(8 + payload.length);
  buf[0] = streamType;
  buf[4] = (payload.length >>> 24) & 0xff;
  buf[5] = (payload.length >>> 16) & 0xff;
  buf[6] = (payload.length >>> 8) & 0xff;
  buf[7] = payload.length & 0xff;
  buf.set(payload, 8);
  return buf;
}

function collect() {
  const stdout: Uint8Array[] = [];
  const stderr: Uint8Array[] = [];
  const pump = createFrameParser({
    onStdout: (b) => stdout.push(new Uint8Array(b)), // copy to detach from buffer reuse
    onStderr: (b) => stderr.push(new Uint8Array(b)),
  });
  return {
    stdout,
    stderr,
    pump,
    concat: (arr: Uint8Array[]) => {
      const total = arr.reduce((n, c) => n + c.length, 0);
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of arr) {
        out.set(c, off);
        off += c.length;
      }
      return out;
    },
  };
}

const enc = new TextEncoder();

describe("createFrameParser", () => {
  test("parses a single stdout frame delivered in one chunk", () => {
    const { stdout, stderr, pump, concat } = collect();
    pump(frame(1, enc.encode("hello")));
    expect(new TextDecoder().decode(concat(stdout))).toBe("hello");
    expect(stderr).toHaveLength(0);
  });

  test("routes stderr frames to onStderr", () => {
    const { stdout, stderr, pump, concat } = collect();
    pump(frame(2, enc.encode("oops")));
    expect(new TextDecoder().decode(concat(stderr))).toBe("oops");
    expect(stdout).toHaveLength(0);
  });

  test("handles multiple frames in one chunk", () => {
    const { stdout, stderr, pump, concat } = collect();
    const f1 = frame(1, enc.encode("a"));
    const f2 = frame(2, enc.encode("b"));
    const combined = new Uint8Array(f1.length + f2.length);
    combined.set(f1);
    combined.set(f2, f1.length);
    pump(combined);
    expect(new TextDecoder().decode(concat(stdout))).toBe("a");
    expect(new TextDecoder().decode(concat(stderr))).toBe("b");
  });

  test("handles header split across two chunks", () => {
    const { stdout, pump, concat } = collect();
    const f = frame(1, enc.encode("hello"));
    // Split right in the middle of the 8-byte header
    pump(f.subarray(0, 3));
    pump(f.subarray(3));
    expect(new TextDecoder().decode(concat(stdout))).toBe("hello");
  });

  test("handles header split into 8 single-byte chunks", () => {
    const { stdout, pump, concat } = collect();
    const f = frame(1, enc.encode("xy"));
    for (let i = 0; i < f.length; i++) pump(f.subarray(i, i + 1));
    expect(new TextDecoder().decode(concat(stdout))).toBe("xy");
  });

  test("handles payload split mid-stream", () => {
    const { stdout, pump, concat } = collect();
    const f = frame(1, enc.encode("hello world"));
    // 8-byte header complete, then split payload at byte 4
    pump(f.subarray(0, 12)); // header + "hell"
    pump(f.subarray(12)); // "o world"
    expect(new TextDecoder().decode(concat(stdout))).toBe("hello world");
  });

  test("payload split mid-UTF-8 codepoint stays correct after concat", () => {
    const { stdout, pump, concat } = collect();
    // "héllo" = 68 c3 a9 6c 6c 6f (6 bytes); é is 0xC3 0xA9
    const f = frame(1, enc.encode("héllo"));
    // Header is 8 bytes; payload starts at offset 8. Split between 0xC3 and 0xA9.
    pump(f.subarray(0, 10)); // header + "h" + 0xC3
    pump(f.subarray(10)); // 0xA9 + "llo"
    // The parser emits raw bytes — concatenating them and decoding yields "héllo".
    expect(new TextDecoder().decode(concat(stdout))).toBe("héllo");
  });

  test("multiple frames split across many chunks", () => {
    const { stdout, stderr, pump, concat } = collect();
    const f1 = frame(1, enc.encode("first"));
    const f2 = frame(2, enc.encode("ERR"));
    const f3 = frame(1, enc.encode("third"));
    const combined = new Uint8Array(f1.length + f2.length + f3.length);
    combined.set(f1);
    combined.set(f2, f1.length);
    combined.set(f3, f1.length + f2.length);
    // Feed two bytes at a time
    for (let i = 0; i < combined.length; i += 2) {
      pump(combined.subarray(i, Math.min(i + 2, combined.length)));
    }
    expect(new TextDecoder().decode(concat(stdout))).toBe("firstthird");
    expect(new TextDecoder().decode(concat(stderr))).toBe("ERR");
  });

  test("empty payload (zero-length frame) is tolerated", () => {
    const { stdout, pump, concat } = collect();
    pump(frame(1, new Uint8Array(0)));
    pump(frame(1, enc.encode("after")));
    expect(new TextDecoder().decode(concat(stdout))).toBe("after");
  });
});
