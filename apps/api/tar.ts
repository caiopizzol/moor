// Minimal POSIX ustar tar archive builder. moor injects declarative project
// files into a container via Docker's PUT /containers/{id}/archive endpoint,
// which extracts a tar at a target path. We only ever emit regular files with
// an explicit mode, so a hand-rolled writer keeps this dependency-free.
//
// Layout: one 512-byte header block per entry, the file body padded up to the
// next 512-byte boundary, then two zero blocks marking end-of-archive.

export type TarEntry = {
  /** Archive member name. For Docker /archive we PUT with ?path=/ and pass the
   *  absolute destination minus its leading slash, so Docker extracts it to the
   *  intended absolute path (creating parent directories as needed). */
  name: string;
  content: string | Uint8Array;
  /** Unix permission bits, e.g. 0o600. Written to the header mode field. */
  mode: number;
};

const BLOCK_SIZE = 512;
const NAME_FIELD = 100;
const PREFIX_FIELD = 155;

/** Write a value as NUL-terminated, zero-padded octal into a fixed-width field.
 *  fieldLength includes the trailing NUL, leaving fieldLength-1 octal digits. */
function writeOctal(buf: Uint8Array, offset: number, fieldLength: number, value: number): void {
  const digits = fieldLength - 1;
  const text = value.toString(8).padStart(digits, "0");
  for (let i = 0; i < digits; i++) buf[offset + i] = text.charCodeAt(i);
  buf[offset + digits] = 0;
}

/** Write ASCII into a fixed-width field (no NUL forced; field is pre-zeroed). */
function writeString(buf: Uint8Array, offset: number, fieldLength: number, value: string): void {
  for (let i = 0; i < value.length && i < fieldLength; i++) {
    buf[offset + i] = value.charCodeAt(i) & 0xff;
  }
}

/** Split a path into ustar (name, prefix) fields. Names up to 100 bytes go in
 *  `name` directly; longer ones split on a `/` so the tail fits in name (<=100)
 *  and the head in prefix (<=155), giving an effective ceiling of ~255. Throws
 *  if no such split exists — callers validate length first, so this is a guard
 *  against a silently-truncated (wrong) path rather than an expected path. */
export function splitUstarName(name: string): { name: string; prefix: string } {
  if (name.length <= NAME_FIELD) return { name, prefix: "" };
  // Walk slashes right-to-left, picking the split where the tail fits `name`
  // (<=100) and the head fits `prefix` (<=155).
  let slash = name.lastIndexOf("/", name.length - 1);
  while (slash > 0) {
    const head = name.slice(0, slash);
    const tail = name.slice(slash + 1);
    if (tail.length <= NAME_FIELD && head.length <= PREFIX_FIELD) {
      return { name: tail, prefix: head };
    }
    slash = name.lastIndexOf("/", slash - 1);
  }
  throw new Error(`tar: path too long to encode in ustar format: ${name}`);
}

function buildHeader(rawName: string, mode: number, size: number): Uint8Array {
  const { name, prefix } = splitUstarName(rawName);
  const header = new Uint8Array(BLOCK_SIZE);
  writeString(header, 0, NAME_FIELD, name);
  // Mask to permission + setuid/setgid/sticky bits; ignore any file-type bits.
  writeOctal(header, 100, 8, mode & 0o7777);
  writeOctal(header, 108, 8, 0); // uid: root
  writeOctal(header, 116, 8, 0); // gid: root
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0); // mtime 0 — deterministic archives
  header[156] = 0x30; // typeflag '0' = regular file
  writeString(header, 257, 6, "ustar"); // magic (NUL-terminated by pre-zeroing)
  header[263] = 0x30; // version '0'
  header[264] = 0x30; // version '0'
  writeString(header, 345, PREFIX_FIELD, prefix);

  // Checksum: sum of every header byte with the 8-byte chksum field taken as
  // spaces, then stored as 6 octal digits + NUL + space.
  for (let i = 0; i < 8; i++) header[148 + i] = 0x20;
  let sum = 0;
  for (let i = 0; i < BLOCK_SIZE; i++) sum += header[i];
  const chk = (sum & 0o777777).toString(8).padStart(6, "0");
  for (let i = 0; i < 6; i++) header[148 + i] = chk.charCodeAt(i);
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function padToBlock(length: number): number {
  const rem = length % BLOCK_SIZE;
  return rem === 0 ? 0 : BLOCK_SIZE - rem;
}

/** Build a tar archive from the given entries. Pure: same input → same bytes. */
export function buildTar(entries: TarEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const entry of entries) {
    const body = typeof entry.content === "string" ? encoder.encode(entry.content) : entry.content;
    chunks.push(buildHeader(entry.name, entry.mode, body.length));
    chunks.push(body);
    const pad = padToBlock(body.length);
    if (pad > 0) chunks.push(new Uint8Array(pad));
  }
  chunks.push(new Uint8Array(BLOCK_SIZE * 2)); // end-of-archive marker

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
