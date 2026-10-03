import { pushVarint, decodeVarint } from './varint.js';

// Sparse bitset stored as 32-bit chunks, serialized with varint-encoded
// chunk-index deltas and varint-encoded words.
export class ChunkedBitset {
  constructor() {
    this.chunks = new Map(); // chunkIndex -> uint32 word
  }

  set(pos) {
    if (!Number.isSafeInteger(pos) || pos < 0) throw new Error(`bad bit position ${pos}`);
    const i = Math.floor(pos / 32);
    this.chunks.set(i, (this.chunks.get(i) ?? 0) | (1 << (pos % 32)));
  }

  has(pos) {
    const w = this.chunks.get(Math.floor(pos / 32));
    return w !== undefined && ((w >>> (pos % 32)) & 1) === 1;
  }

  get size() {
    let n = 0;
    for (const w of this.chunks.values()) {
      let v = w;
      while (v) { v &= v - 1; n++; }
    }
    return n;
  }

  positions() {
    const out = [];
    for (const [i, w] of [...this.chunks.entries()].sort((a, b) => a[0] - b[0])) {
      for (let b = 0; b < 32; b++) {
        if ((w >>> b) & 1) out.push(i * 32 + b);
      }
    }
    return out;
  }

  encode() {
    const out = [];
    const entries = [...this.chunks.entries()].sort((a, b) => a[0] - b[0]);
    pushVarint(out, entries.length);
    let prev = 0;
    for (const [i, w] of entries) {
      pushVarint(out, i - prev);
      prev = i;
      pushVarint(out, w >>> 0);
    }
    return Uint8Array.from(out);
  }

  static decode(bytes, offset = 0) {
    const bs = new ChunkedBitset();
    let r = decodeVarint(bytes, offset);
    const count = r.value;
    let chunkIndex = 0;
    for (let k = 0; k < count; k++) {
      r = decodeVarint(bytes, r.offset);
      chunkIndex += r.value;
      r = decodeVarint(bytes, r.offset);
      bs.chunks.set(chunkIndex, r.value >>> 0);
    }
    return { bitset: bs, offset: r.offset };
  }
}
