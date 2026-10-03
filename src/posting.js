import { encodeVarint, decodeVarint } from './varint.js';

// Posting list compressed as chunked bitset + varint:
//   chunkCount(varint)
//   per chunk (64 doc ids):
//     chunkIdDelta(varint), bitmap(8 bytes, bit = docId % 64),
//     per present doc: posCount(varint), position deltas(varint)*
const CHUNK_BITS = 64;

export function encodePosting(docPositions) {
  const docIds = [...docPositions.keys()].sort((a, b) => a - b);
  const chunks = new Map();
  for (const id of docIds) {
    const cid = Math.floor(id / CHUNK_BITS);
    if (!chunks.has(cid)) chunks.set(cid, []);
    chunks.get(cid).push(id);
  }
  const bytes = [];
  bytes.push(...encodeVarint(chunks.size));
  let prevChunk = 0;
  for (const [cid, ids] of [...chunks.entries()].sort((a, b) => a[0] - b[0])) {
    bytes.push(...encodeVarint(cid - prevChunk));
    prevChunk = cid;
    const bitmap = new Array(8).fill(0);
    for (const id of ids) {
      const bit = id % CHUNK_BITS;
      bitmap[Math.floor(bit / 8)] |= 1 << (bit % 8);
    }
    bytes.push(...bitmap);
    for (const id of ids) {
      const positions = docPositions.get(id);
      bytes.push(...encodeVarint(positions.length));
      let prev = 0;
      for (const p of positions) {
        bytes.push(...encodeVarint(p - prev));
        prev = p;
      }
    }
  }
  return Uint8Array.from(bytes);
}

export function decodePosting(buf) {
  const result = new Map();
  let offset = 0;
  let value;
  [value, offset] = decodeVarint(buf, offset);
  const chunkCount = value;
  let prevChunk = 0;
  for (let c = 0; c < chunkCount; c++) {
    [value, offset] = decodeVarint(buf, offset);
    const cid = value + prevChunk;
    prevChunk = cid;
    const bitmap = buf.slice(offset, offset + 8);
    offset += 8;
    for (let bit = 0; bit < CHUNK_BITS; bit++) {
      if (bitmap[Math.floor(bit / 8)] & (1 << (bit % 8))) {
        const docId = cid * CHUNK_BITS + bit;
        let count;
        [count, offset] = decodeVarint(buf, offset);
        const positions = [];
        let prev = 0;
        for (let i = 0; i < count; i++) {
          let delta;
          [delta, offset] = decodeVarint(buf, offset);
          prev += delta;
          positions.push(prev);
        }
        result.set(docId, positions);
      }
    }
  }
  return result;
}
