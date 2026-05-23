// Byte-aware UTF-8 tail-trim used by moor_exec_status (#44). The MCP tool
// can't return the full API tail (up to 64 KiB per stream) inline because
// large responses blow agent token budgets. Caller picks how many bytes per
// stream they want; the trim is UTF-8 safe — the result never starts mid-
// codepoint, which would cause TextDecoder to emit U+FFFD at the head.

export function tailUtf8(
  s: string,
  maxBytes: number,
): { tail: string; storedBytes: number; trimmed: boolean } {
  const bytes = new TextEncoder().encode(s);
  const storedBytes = bytes.length;
  if (storedBytes <= maxBytes) return { tail: s, storedBytes, trimmed: false };
  if (maxBytes === 0) return { tail: "", storedBytes, trimmed: true };
  // Start at the offset that leaves maxBytes bytes; walk forward past any
  // UTF-8 continuation bytes (10xxxxxx) so the decoded tail begins on a
  // codepoint boundary.
  let start = storedBytes - maxBytes;
  while (start < storedBytes && (bytes[start] & 0xc0) === 0x80) start++;
  return {
    tail: new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(start)),
    storedBytes,
    trimmed: true,
  };
}
