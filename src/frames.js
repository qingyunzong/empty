'use strict';
const { crc32 } = require('./crc');
const { canonical } = require('./util');

class ProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProtocolError';
  }
}

const PHASES = new Set(['prepare', 'commit', 'abort']);

function signFields(fields) {
  return crc32(canonical(fields));
}

// Message wire format: {tx, phase, acct, amount, seq, ack, crc, ...extra}
// crc covers every field except itself, over the canonical (sorted-key) JSON.
function encodeMessage(msg) {
  const { crc, ...rest } = msg;
  return JSON.stringify({ ...rest, crc: signFields(rest) });
}

function decodeMessage(frame) {
  let msg;
  try {
    msg = JSON.parse(frame);
  } catch {
    throw new ProtocolError('frame is not valid JSON');
  }
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
    throw new ProtocolError('frame is not a message object');
  }
  for (const field of ['tx', 'phase', 'acct', 'amount', 'seq', 'ack', 'crc']) {
    if (!(field in msg)) throw new ProtocolError(`message missing field ${field}`);
  }
  if (typeof msg.tx !== 'string') throw new ProtocolError('tx must be a string');
  if (!PHASES.has(msg.phase)) throw new ProtocolError(`unknown phase ${msg.phase}`);
  if (typeof msg.acct !== 'string') throw new ProtocolError('acct must be a string');
  for (const field of ['amount', 'seq', 'ack']) {
    if (!Number.isFinite(msg[field])) throw new ProtocolError(`${field} must be a finite number`);
  }
  const { crc, ...rest } = msg;
  if (typeof crc !== 'string' || signFields(rest) !== crc) throw new ProtocolError('crc mismatch');
  return msg;
}

// Split a frame into n chunks for fragmentation simulation.
function fragmentFrame(frame, n, fid) {
  const size = Math.ceil(frame.length / n);
  const chunks = [];
  for (let i = 0; i < n; i++) {
    chunks.push({ frag: fid, idx: i, total: n, data: frame.slice(i * size, (i + 1) * size) });
  }
  return chunks;
}

class Reassembler {
  constructor() {
    this.parts = new Map();
  }
  push(chunk) {
    let entry = this.parts.get(chunk.frag);
    if (!entry) {
      entry = { total: chunk.total, got: new Map() };
      this.parts.set(chunk.frag, entry);
    }
    if (entry.total !== chunk.total) throw new ProtocolError('inconsistent fragment total');
    entry.got.set(chunk.idx, chunk.data);
    if (entry.got.size !== entry.total) return null;
    this.parts.delete(chunk.frag);
    let frame = '';
    for (let i = 0; i < entry.total; i++) {
      if (!entry.got.has(i)) throw new ProtocolError('fragment gap');
      frame += entry.got.get(i);
    }
    return frame;
  }
}

module.exports = { ProtocolError, PHASES, encodeMessage, decodeMessage, fragmentFrame, Reassembler };
