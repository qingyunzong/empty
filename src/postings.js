import { deflateRawSync, inflateRawSync } from 'node:zlib';

export const BLOCK_SIZE = 4; // postings entries (docs) per compressed block

function writeVarint(out, n) {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`bad varint: ${n}`);
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
}

function readVarint(buf, state) {
  let result = 0;
  let shift = 0;
  let byte;
  do {
    byte = buf[state.pos];
    state.pos += 1;
    result += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  } while (byte & 0x80);
  return result;
}

// entries: [{ docId: <int>, positions: [<int>...] }] sorted by docId asc.
// Returns { data, blocks } where each block header carries:
//   maxDocId  - largest docID inside the block (skip support)
//   posBase   - total number of positions in all preceding blocks (位置基数)
//   offset/length - location of the deflate-compressed payload in `data`
export function encodePostings(entries, blockSize = BLOCK_SIZE) {
  const chunks = [];
  const blocks = [];
  let offset = 0;
  let posBase = 0;
  for (let i = 0; i < entries.length; i += blockSize) {
    const group = entries.slice(i, i + blockSize);
    const bytes = [];
    let prevDocId = 0; // docID deltas restart per block: blocks decode independently
    let positionsInBlock = 0;
    for (const entry of group) {
      writeVarint(bytes, entry.docId - prevDocId);
      prevDocId = entry.docId;
      writeVarint(bytes, entry.positions.length);
      positionsInBlock += entry.positions.length;
      let prevPos = 0;
      for (const p of entry.positions) {
        writeVarint(bytes, p - prevPos);
        prevPos = p;
      }
    }
    const payload = deflateRawSync(Buffer.from(bytes));
    blocks.push({
      maxDocId: group[group.length - 1].docId,
      posBase,
      offset,
      length: payload.length,
    });
    posBase += positionsInBlock;
    offset += payload.length;
    chunks.push(payload);
  }
  return { data: Buffer.concat(chunks), blocks };
}

function decodeBlock(payload) {
  const buf = inflateRawSync(payload);
  const entries = [];
  const state = { pos: 0 };
  let prevDocId = 0;
  while (state.pos < buf.length) {
    prevDocId += readVarint(buf, state);
    const count = readVarint(buf, state);
    const positions = [];
    let prevPos = 0;
    for (let i = 0; i < count; i += 1) {
      prevPos += readVarint(buf, state);
      positions.push(prevPos);
    }
    entries.push({ docId: prevDocId, positions });
  }
  return entries;
}

// Forward-only cursor over one term's blocked postings.
// advance(target) skips whole blocks whose header maxDocId < target
// without decompressing them.
export class PostingsCursor {
  constructor(data, blocks) {
    this.data = data;
    this.blocks = blocks;
    this.blockIndex = -1;
    this.entries = [];
    this.entryIndex = 0;
    this.current = null;
  }

  _loadBlock(i) {
    const header = this.blocks[i];
    const payload = this.data.subarray(header.offset, header.offset + header.length);
    this.entries = decodeBlock(payload);
    this.blockIndex = i;
    this.entryIndex = 0;
  }

  next() {
    for (;;) {
      if (this.entryIndex < this.entries.length) {
        this.current = this.entries[this.entryIndex];
        this.entryIndex += 1;
        return this.current;
      }
      if (this.blockIndex + 1 >= this.blocks.length) {
        this.current = null;
        return null;
      }
      this._loadBlock(this.blockIndex + 1);
    }
  }

  // Returns the next entry with docId >= target, or null. Never moves backward.
  advance(target) {
    for (;;) {
      if (this.current && this.current.docId >= target) return this.current;
      while (this.entryIndex < this.entries.length) {
        const e = this.entries[this.entryIndex];
        this.entryIndex += 1;
        if (e.docId >= target) {
          this.current = e;
          return e;
        }
      }
      let nextBlock = this.blockIndex + 1;
      while (nextBlock < this.blocks.length && this.blocks[nextBlock].maxDocId < target) {
        nextBlock += 1; // skip block purely via its header, no decompression
      }
      if (nextBlock >= this.blocks.length) {
        this.blockIndex = this.blocks.length;
        this.entries = [];
        this.entryIndex = 0;
        this.current = null;
        return null;
      }
      this._loadBlock(nextBlock);
    }
  }
}
