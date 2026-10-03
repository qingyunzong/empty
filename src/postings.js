// Block-compressed positional postings.
//
// Entry: { doc, pos, para }. Entries are sorted by (doc, pos).
// Each block header stores maxDoc (max docID in block) and posBase
// (position base = min pos in block); the payload is base64 varints:
//   count, then per entry: docDelta (from previous doc), pos - posBase, para.
// Block headers allow skipping: a block whose maxDoc is below the seek
// target is never decoded.

export const BLOCK_SIZE = 8;

export function encodeVarints(nums) {
  const bytes = [];
  for (const n of nums) {
    if (!Number.isInteger(n) || n < 0) throw new Error(`varint: bad value ${n}`);
    let v = n;
    while (v >= 0x80) {
      bytes.push((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    bytes.push(v);
  }
  return Buffer.from(bytes);
}

export function decodeVarints(buf) {
  const out = [];
  let v = 0;
  let shift = 0;
  for (const b of buf) {
    v += (b & 0x7f) * 2 ** shift;
    if (b & 0x80) shift += 7;
    else {
      out.push(v);
      v = 0;
      shift = 0;
    }
  }
  if (shift !== 0) throw new Error('varint: truncated buffer');
  return out;
}

export function encodeBlock(entries) {
  if (entries.length === 0) throw new Error('cannot encode empty block');
  const maxDoc = entries[entries.length - 1].doc;
  const posBase = Math.min(...entries.map((e) => e.pos));
  const nums = [entries.length];
  let prevDoc = 0;
  for (const e of entries) {
    nums.push(e.doc - prevDoc, e.pos - posBase, e.para);
    prevDoc = e.doc;
  }
  return { maxDoc, posBase, data: encodeVarints(nums).toString('base64') };
}

export function decodeBlock(block) {
  const nums = decodeVarints(Buffer.from(block.data, 'base64'));
  const count = nums[0];
  const out = [];
  let doc = 0;
  let i = 1;
  for (let n = 0; n < count; n++) {
    doc += nums[i++];
    out.push({ doc, pos: block.posBase + nums[i++], para: nums[i++] });
  }
  return out;
}

export function encodePostings(entries) {
  const blocks = [];
  for (let i = 0; i < entries.length; i += BLOCK_SIZE) {
    blocks.push(encodeBlock(entries.slice(i, i + BLOCK_SIZE)));
  }
  return blocks;
}

// Cursor over a posting list { blocks, tail }. `tail` holds not-yet-packed
// entries from incremental adds. seekDoc skips whole blocks via maxDoc.
export class PostingCursor {
  constructor(posting) {
    this.blocks = posting.blocks;
    this.tail = posting.tail;
    this.bi = 0;
    this.entries = [];
    this.ei = 0;
    this.inTail = false;
    this.blocksDecoded = 0; // instrumentation: proves skipping
    if (this.blocks.length > 0) this._loadBlock(0);
    else this._loadTail();
  }

  _loadBlock(i) {
    this.entries = decodeBlock(this.blocks[i]);
    this.blocksDecoded++;
    this.ei = 0;
  }

  _loadTail() {
    this.inTail = true;
    this.entries = this.tail;
    this.ei = 0;
  }

  _nextBlock() {
    if (this.inTail) {
      this.entries = [];
      this.ei = 0;
      return;
    }
    this.bi++;
    if (this.bi < this.blocks.length) this._loadBlock(this.bi);
    else this._loadTail();
  }

  current() {
    return this.ei < this.entries.length ? this.entries[this.ei] : null;
  }

  advance() {
    this.ei++;
    while (this.ei >= this.entries.length) {
      if (this.inTail) {
        this.entries = [];
        this.ei = 0;
        break;
      }
      this._nextBlock();
      if (this.entries.length === 0) break;
    }
    return this.current();
  }

  // First entry with doc >= target; blocks with maxDoc < target are skipped
  // without decoding.
  seekDoc(target) {
    for (;;) {
      const cur = this.current();
      if (cur === null) return null;
      if (cur.doc >= target) return cur;
      if (!this.inTail && this.blocks[this.bi].maxDoc < target) {
        // Skip all consecutive blocks below target without decoding them.
        do {
          this.bi++;
        } while (this.bi < this.blocks.length && this.blocks[this.bi].maxDoc < target);
        if (this.bi < this.blocks.length) this._loadBlock(this.bi);
        else this._loadTail();
        continue;
      }
      this.advance();
    }
  }
}
