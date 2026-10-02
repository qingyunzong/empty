'use strict';

const { FRAME_LEN, FrameError, decodeFrame } = require('./frame');

// Streaming deframer: accepts arbitrary byte chunks (frames may be fragmented
// across chunk boundaries) and yields complete decoded frames.
class Deframer {
  constructor() {
    this.buf = Buffer.alloc(0);
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
    const frames = [];
    while (this.buf.length >= 2) {
      const len = this.buf.readUInt16BE(0);
      if (len !== FRAME_LEN) throw new FrameError(`corrupt stream: len field ${len}`);
      if (this.buf.length < len) break;
      const raw = this.buf.subarray(0, len);
      this.buf = this.buf.subarray(len);
      frames.push(decodeFrame(raw));
    }
    return frames;
  }

  finish() {
    if (this.buf.length !== 0) throw new FrameError(`truncated tail: ${this.buf.length} leftover bytes`);
  }
}

// Per-member reliable-delivery session.
//  - seq < expected  -> retransmission, flagged duplicate (caller replays cached reply)
//  - seq > expected  -> out of order, parked in the holdback queue
//  - seq == expected -> delivered, then consecutive buffered frames drain in order
class LinkSession {
  constructor() {
    this.expected = new Map();  // member -> next expected seq
    this.holdback = new Map();  // member -> Map(seq -> frame)
  }

  ingest(frame) {
    const member = frame.member;
    if (!this.expected.has(member)) {
      this.expected.set(member, 1);
      this.holdback.set(member, new Map());
    }
    const expected = this.expected.get(member);
    if (frame.seq < expected) return [{ frame, duplicate: true }];
    if (frame.seq > expected) {
      const queue = this.holdback.get(member);
      if (!queue.has(frame.seq)) queue.set(frame.seq, frame);
      return [];
    }
    const out = [{ frame, duplicate: false }];
    const queue = this.holdback.get(member);
    let next = expected + 1;
    while (queue.has(next)) {
      out.push({ frame: queue.get(next), duplicate: false });
      queue.delete(next);
      next += 1;
    }
    this.expected.set(member, next);
    return out;
  }
}

module.exports = { Deframer, LinkSession };
