'use strict';

const { MAGIC, TYPE, FRAME_LEN, decodeFrame, decodeFrag, CorruptFrameError } = require('./frame');

// Link layer: turns a byte stream into an ordered, de-duplicated stream of
// complete frames. Handles fragmentation (FRAG records), retransmission
// (identical seq dropped, conflicting seq is corruption) and reordering
// (frames are delivered in seq order starting at baseSeq; anything still
// buffered at end() is flushed in seq order).
class Link {
  constructor({ baseSeq = 1 } = {}) {
    this.buf = Buffer.alloc(0);
    this.frags = new Map();   // seq -> { parts: Map(offset -> Buffer), received, total }
    this.seen = new Map();    // seq -> hex digest of the first record seen for it
    this.reorder = new Map(); // seq -> frame (complete, waiting for gaps to fill)
    this.next = baseSeq;
    this.duplicates = 0;
  }

  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    return this._parse();
  }

  end() {
    if (this.buf.length) throw new CorruptFrameError(`truncated record: ${this.buf.length} trailing byte(s)`);
    if (this.frags.size) throw new CorruptFrameError('incomplete fragmented frame at end of stream');
    const rest = [...this.reorder.entries()].sort((a, b) => a[0] - b[0]).map(([, frame]) => frame);
    this.reorder.clear();
    return rest;
  }

  _parse() {
    const delivered = [];
    for (;;) {
      if (this.buf.length < 4) break;
      if (this.buf.readUInt16BE(0) !== MAGIC) throw new CorruptFrameError('bad magic in stream');
      const len = this.buf.readUInt16BE(2);
      if (len < 10) throw new CorruptFrameError(`implausible record length ${len}`);
      if (this.buf.length < len) break; // wait for more bytes
      const record = this.buf.subarray(0, len);
      this.buf = this.buf.subarray(len);
      if (record[4] === TYPE.FRAG) this._handleFrag(record, delivered);
      else this._handleFull(record, delivered);
    }
    return delivered;
  }

  _handleFull(record, delivered) {
    const frame = decodeFrame(record);
    const digest = record.toString('hex');
    if (this.seen.has(frame.seq)) {
      if (this.seen.get(frame.seq) !== digest) {
        throw new CorruptFrameError(`conflicting retransmission for seq=${frame.seq}`);
      }
      this.duplicates++;
      return;
    }
    this.seen.set(frame.seq, digest);
    this.reorder.set(frame.seq, frame);
    while (this.reorder.has(this.next)) {
      delivered.push(this.reorder.get(this.next));
      this.reorder.delete(this.next);
      this.next++;
    }
  }

  _handleFrag(record, delivered) {
    const frag = decodeFrag(record);
    if (frag.total !== FRAME_LEN) throw new CorruptFrameError(`bad frag total ${frag.total}`);
    if (this.seen.has(frag.seq)) { this.duplicates++; return; }
    let asm = this.frags.get(frag.seq);
    if (!asm) {
      asm = { parts: new Map(), received: 0, total: frag.total };
      this.frags.set(frag.seq, asm);
    }
    if (asm.total !== frag.total) throw new CorruptFrameError('frag total mismatch');
    const existing = asm.parts.get(frag.offset);
    if (existing) {
      if (!existing.equals(frag.data)) throw new CorruptFrameError('conflicting fragment data');
      this.duplicates++;
      return;
    }
    asm.parts.set(frag.offset, frag.data);
    asm.received += frag.data.length;
    if (asm.received === asm.total) {
      const out = Buffer.alloc(asm.total);
      let pos = 0;
      for (const off of [...asm.parts.keys()].sort((a, b) => a - b)) {
        if (off !== pos) throw new CorruptFrameError('fragment gap or overlap');
        const data = asm.parts.get(off);
        data.copy(out, pos);
        pos += data.length;
      }
      this.frags.delete(frag.seq);
      this._handleFull(out, delivered);
    }
  }
}

module.exports = { Link };
