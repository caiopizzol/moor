// Rolling tail buffer for async exec output. A 24h job can emit GB of stdout;
// we keep only the last N bytes in memory and report the original byte count
// separately so callers can tell truncation happened. UTF-8 safe: trimming
// from the start advances past any continuation bytes so the decoded tail
// never starts mid-codepoint.

export const TAIL_CAP_BYTES = 64 * 1024;

export class TailBuffer {
  // Fixed-size storage with headroom; we compact in place rather than
  // allocating on every append.
  private readonly buf: Uint8Array;
  private size = 0;
  private total = 0;

  constructor(private readonly capBytes: number = TAIL_CAP_BYTES) {
    this.buf = new Uint8Array(capBytes * 2);
  }

  appendBytes(b: Uint8Array): void {
    this.total += b.length;

    // Case 1: incoming chunk alone exceeds cap — keep only its tail.
    if (b.length >= this.capBytes) {
      const slice = b.subarray(b.length - this.capBytes);
      this.buf.set(slice, 0);
      this.size = this.capBytes;
      this.alignToUtf8Start();
      return;
    }

    // Case 2: append would overflow physical buffer — compact, keeping the
    // most recent cap bytes of what we already have.
    if (this.size + b.length > this.buf.length) {
      const keep = Math.min(this.size, this.capBytes);
      this.buf.copyWithin(0, this.size - keep, this.size);
      this.size = keep;
    }

    this.buf.set(b, this.size);
    this.size += b.length;

    // Case 3: logical size exceeds cap — drop oldest bytes to bring back to cap.
    if (this.size > this.capBytes) {
      const drop = this.size - this.capBytes;
      this.buf.copyWithin(0, drop, this.size);
      this.size -= drop;
    }

    this.alignToUtf8Start();
  }

  /** UTF-8 continuation bytes have the bit pattern 10xxxxxx (0x80-0xBF). If we
   *  truncated in the middle of a multi-byte sequence, the leading bytes will
   *  be continuations with no start byte. Skip them so decode() doesn't emit
   *  replacement characters at the head of the tail. */
  private alignToUtf8Start(): void {
    let i = 0;
    while (i < this.size && (this.buf[i] & 0xc0) === 0x80) i++;
    if (i > 0) {
      this.buf.copyWithin(0, i, this.size);
      this.size -= i;
    }
  }

  /** Find the latest byte index that ends a complete UTF-8 codepoint.
   *  A stream chunk may end mid-codepoint (start byte received, continuation
   *  bytes not yet); without trimming, TextDecoder emits U+FFFD at the tail.
   *  Live status overlays the live tail, so the partial suffix would be
   *  visible. Return the index up to (but not including) a partial sequence. */
  private utf8EndBoundary(): number {
    if (this.size === 0) return 0;
    // Walk back to the most recent lead byte. Continuation bytes have the
    // top two bits 10; anything else is a lead (ASCII or multi-byte start).
    let s = this.size - 1;
    while (s > 0 && (this.buf[s] & 0xc0) === 0x80) s--;
    const lead = this.buf[s];
    let expected: number;
    if ((lead & 0x80) === 0)
      expected = 1; // 0xxxxxxx
    else if ((lead & 0xe0) === 0xc0)
      expected = 2; // 110xxxxx
    else if ((lead & 0xf0) === 0xe0)
      expected = 3; // 1110xxxx
    else if ((lead & 0xf8) === 0xf0)
      expected = 4; // 11110xxx
    else expected = 1; // invalid; let the decoder emit a replacement and move on
    return this.size - s >= expected ? this.size : s;
  }

  get tail(): string {
    return new TextDecoder("utf-8", { fatal: false }).decode(
      this.buf.subarray(0, this.utf8EndBoundary()),
    );
  }

  get totalBytes(): number {
    return this.total;
  }

  get tailBytes(): number {
    return this.size;
  }
}
