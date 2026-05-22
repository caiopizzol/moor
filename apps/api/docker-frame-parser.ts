// Docker exec's attached output stream is multiplexed. Each frame is:
//
//   [type:1][padding:3][size:4 BE][payload:size]
//
// type 1 = stdout, type 2 = stderr. The full execInContainer parser buffers
// the whole arrayBuffer() and walks it linearly. The async exec path receives
// the body as a Web Streams reader, so frames may arrive in arbitrary chunks:
// a single read() can split the 8-byte header, end mid-payload, or carry
// multiple frames. This parser is a tiny state machine fed via pump(chunk).
//
// The parser does NOT decode UTF-8 — it emits raw byte slices to the caller.
// TailBuffer takes Uint8Array and handles UTF-8 alignment at decode time, so
// a payload split mid-codepoint never produces replacement characters.

type State =
  | { phase: "header"; have: number; bytes: Uint8Array }
  | { phase: "payload"; type: number; remaining: number };

export type FrameCallbacks = {
  onStdout: (b: Uint8Array) => void;
  onStderr: (b: Uint8Array) => void;
};

export function createFrameParser(cb: FrameCallbacks): (chunk: Uint8Array) => void {
  let state: State = { phase: "header", have: 0, bytes: new Uint8Array(8) };

  return function pump(chunk: Uint8Array): void {
    let i = 0;
    while (i < chunk.length) {
      if (state.phase === "header") {
        const need = 8 - state.have;
        const take = Math.min(need, chunk.length - i);
        state.bytes.set(chunk.subarray(i, i + take), state.have);
        state.have += take;
        i += take;
        if (state.have === 8) {
          const type = state.bytes[0];
          const size =
            (state.bytes[4] << 24) |
            (state.bytes[5] << 16) |
            (state.bytes[6] << 8) |
            state.bytes[7];
          state = { phase: "payload", type, remaining: size };
        }
      } else {
        const take = Math.min(state.remaining, chunk.length - i);
        if (take > 0) {
          const slice = chunk.subarray(i, i + take);
          if (state.type === 1) cb.onStdout(slice);
          else if (state.type === 2) cb.onStderr(slice);
        }
        i += take;
        state.remaining -= take;
        if (state.remaining === 0) {
          state = { phase: "header", have: 0, bytes: new Uint8Array(8) };
        }
      }
    }
  };
}
