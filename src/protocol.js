'use strict';

// ---------------------------------------------------------------------------
// Wire protocol: newline-delimited JSON frames with seq/ack reliability.
//
//   inbound  {"seq":N,"ack":M,"t":T,"op":{...}}   client -> service
//   outbound {"ack":N,"result":{...}}             service -> client
//
// Responsibilities: framing (one JSON value per line), duplicate suppression
// (a resent frame returns the stored result without re-executing), reordering
// (future frames are buffered until gaps fill), and virtual-clock SLA driving
// (each frame carries its send time `t`; the service clock only moves forward).
// ---------------------------------------------------------------------------

class FrameError extends Error {
  constructor(message) {
    super(message);
    this.code = 'FRAME_ERROR';
  }
}

function parseFrame(line) {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    throw new FrameError('line is not valid JSON');
  }
  if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) {
    throw new FrameError('frame must be a JSON object');
  }
  if (!Number.isInteger(frame.seq) || frame.seq < 0) {
    throw new FrameError('frame.seq must be a non-negative integer');
  }
  if (frame.ack !== undefined && (!Number.isInteger(frame.ack) || frame.ack < 0)) {
    throw new FrameError('frame.ack must be a non-negative integer');
  }
  if (frame.t !== undefined && (typeof frame.t !== 'number' || !Number.isFinite(frame.t))) {
    throw new FrameError('frame.t must be a finite number');
  }
  if (frame.op === undefined || frame.op === null || typeof frame.op !== 'object' || typeof frame.op.op !== 'string') {
    throw new FrameError('frame.op must be an object with a string "op" field');
  }
  return frame;
}

class Protocol {
  constructor() {
    this.expected = 0; // next in-order seq
    this.buffer = new Map(); // seq -> frame (arrived early)
    this.results = new Map(); // seq -> stored result (for retransmissions)
  }

  // Feed one parsed frame. Returns an array of {ack, result} ready to send.
  ingest(frame, apply) {
    const out = [];
    if (frame.seq < this.expected) {
      const stored = this.results.get(frame.seq);
      if (stored !== undefined) out.push({ ack: frame.seq, result: stored, dup: true });
      return out; // retransmission: replay stored result, never re-execute
    }
    if (frame.seq > this.expected) {
      if (!this.buffer.has(frame.seq)) this.buffer.set(frame.seq, frame);
      return out; // out of order: hold until the gap fills
    }
    this._deliver(frame, apply, out);
    while (this.buffer.has(this.expected)) {
      const next = this.buffer.get(this.expected);
      this.buffer.delete(this.expected);
      this._deliver(next, apply, out);
    }
    return out;
  }

  _deliver(frame, apply, out) {
    const result = apply(frame.op, frame.t, frame.seq);
    this.results.set(frame.seq, result);
    this.expected = frame.seq + 1;
    out.push({ ack: frame.seq, result });
  }
}

module.exports = { Protocol, FrameError, parseFrame };
