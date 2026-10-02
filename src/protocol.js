'use strict';

const { encodeFrame, parseFrames, TYPE_DATA, TYPE_ACK, FLAG_EOB } = require('./frame');

// Sender: keeps one copy of every DATA frame per batch and retransmits all
// unacknowledged frames when the retransmit timer (virtual clock) fires.
class Sender {
  constructor(clock, { rtoMs = 1000 } = {}) {
    this.clock = clock;
    this.rtoMs = rtoMs;
    this.batches = new Map();
    this.outbox = [];
  }
  sendBatch(batchId, frames) {
    this.batches.set(batchId, { frames, total: frames.length, ackedThru: 0, timerId: null, aborted: false });
    for (const f of frames) this.outbox.push(f.buf);
    this._schedule(batchId);
  }
  _schedule(batchId) {
    const st = this.batches.get(batchId);
    if (!st || st.aborted || st.ackedThru >= st.total) return;
    if (st.timerId !== null) this.clock.clear(st.timerId);
    st.timerId = this.clock.set(() => this._onTimeout(batchId), this.rtoMs);
  }
  _onTimeout(batchId) {
    const st = this.batches.get(batchId);
    if (!st || st.aborted) return;
    for (const f of st.frames) if (f.seq > st.ackedThru) this.outbox.push(f.buf);
    st.timerId = null;
    this._schedule(batchId);
  }
  onAck(batchId, ack) {
    const st = this.batches.get(batchId);
    if (!st) return;
    const thru = Math.min(ack - 1, st.total);
    if (thru > st.ackedThru) st.ackedThru = thru;
    if (st.ackedThru >= st.total && st.timerId !== null) {
      this.clock.clear(st.timerId);
      st.timerId = null;
    }
  }
  dropBatch(batchId) {
    const st = this.batches.get(batchId);
    if (!st) return;
    st.aborted = true;
    if (st.timerId !== null) this.clock.clear(st.timerId);
    st.timerId = null;
  }
  drain() {
    const out = this.outbox;
    this.outbox = [];
    return out;
  }
}

// Receiver: reassembles a byte stream into frames, dedups and reorders by
// seq per batch, emits lines in order, and answers every DATA frame with a
// cumulative ACK frame (ack = next expected seq).
class Receiver {
  constructor() {
    this.buf = Buffer.alloc(0);
    this.batches = new Map();
    this.ackOut = [];
    this.lineOut = [];
    this.completedOut = [];
    this.errors = [];
  }
  feed(bytes) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, bytes]) : bytes;
    const { frames, rest, errors } = parseFrames(this.buf);
    this.buf = Buffer.from(rest);
    this.errors.push(...errors);
    for (const f of frames) this._onFrame(f);
  }
  _onFrame(f) {
    if (f.type !== TYPE_DATA) return;
    let st = this.batches.get(f.batchId);
    if (!st) {
      st = { expected: 1, buffer: new Map(), eobSeq: null, done: false };
      this.batches.set(f.batchId, st);
    }
    if (f.seq >= st.expected && !st.buffer.has(f.seq)) st.buffer.set(f.seq, f);
    while (st.buffer.has(st.expected)) {
      const fr = st.buffer.get(st.expected);
      st.buffer.delete(st.expected);
      st.expected++;
      this.lineOut.push(fr);
      if (fr.flags & FLAG_EOB) st.eobSeq = fr.seq;
    }
    if (!st.done && st.eobSeq !== null && st.expected > st.eobSeq) {
      st.done = true;
      this.completedOut.push(f.batchId);
    }
    this.ackOut.push(encodeFrame({ type: TYPE_ACK, batchId: f.batchId, ack: st.expected }));
  }
  drainLines() {
    const o = this.lineOut;
    this.lineOut = [];
    return o;
  }
  drainCompleted() {
    const o = this.completedOut;
    this.completedOut = [];
    return o;
  }
  drainAcks() {
    const o = this.ackOut;
    this.ackOut = [];
    return o;
  }
}

module.exports = { Sender, Receiver };
