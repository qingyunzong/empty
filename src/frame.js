'use strict';

const { crc32 } = require('./crc');

const PHASES = new Set(['prepare', 'vote', 'commit', 'abort', 'ack']);

function validateMessage(msg) {
  if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) return 'MALFORMED';
  if (typeof msg.tx !== 'string' || msg.tx.length === 0) return 'BAD_TX';
  if (!PHASES.has(msg.phase)) return 'BAD_PHASE';
  if (typeof msg.acct !== 'string' || msg.acct.length === 0) return 'BAD_ACCT';
  if (typeof msg.amount !== 'number' || !Number.isFinite(msg.amount)) return 'BAD_AMOUNT';
  if (typeof msg.seq !== 'number' || !Number.isInteger(msg.seq) || msg.seq < 0) return 'BAD_SEQ';
  if (typeof msg.ack !== 'string') return 'BAD_ACK';
  return null;
}

function encodeFrame(msg) {
  const err = validateMessage(msg);
  if (err) throw new Error('cannot encode invalid message: ' + err);
  const body = JSON.stringify(msg);
  return JSON.stringify({ body, crc: crc32(body) });
}

function decodeFrame(frameStr) {
  let obj;
  try {
    obj = JSON.parse(frameStr);
  } catch {
    return { ok: false, error: 'MALFORMED_FRAME' };
  }
  if (typeof obj !== 'object' || obj === null || typeof obj.body !== 'string' || typeof obj.crc !== 'number') {
    return { ok: false, error: 'MALFORMED_FRAME' };
  }
  if (crc32(obj.body) !== obj.crc >>> 0) return { ok: false, error: 'CRC_MISMATCH' };
  let msg;
  try {
    msg = JSON.parse(obj.body);
  } catch {
    return { ok: false, error: 'MALFORMED_BODY' };
  }
  const err = validateMessage(msg);
  if (err) return { ok: false, error: err };
  return { ok: true, msg };
}

function chunkFrame(frameId, frameStr, chunkSize) {
  if (!chunkSize || chunkSize <= 0 || frameStr.length <= chunkSize) {
    return [{ frameId, idx: 0, total: 1, data: frameStr }];
  }
  const total = Math.ceil(frameStr.length / chunkSize);
  const chunks = [];
  for (let i = 0; i < total; i++) {
    chunks.push({ frameId, idx: i, total, data: frameStr.slice(i * chunkSize, (i + 1) * chunkSize) });
  }
  return chunks;
}

class Reassembler {
  constructor() {
    this.frames = new Map();
  }

  push(chunk) {
    if (!chunk || typeof chunk.frameId !== 'string' || typeof chunk.data !== 'string') return null;
    if (!Number.isInteger(chunk.idx) || !Number.isInteger(chunk.total) || chunk.total < 1) return null;
    let entry = this.frames.get(chunk.frameId);
    if (!entry) {
      entry = { total: chunk.total, parts: new Map() };
      this.frames.set(chunk.frameId, entry);
    }
    if (entry.total !== chunk.total) return null;
    entry.parts.set(chunk.idx, chunk.data);
    if (entry.parts.size < entry.total) return null;
    let str = '';
    for (let i = 0; i < entry.total; i++) {
      const part = entry.parts.get(i);
      if (part === undefined) return null;
      str += part;
    }
    this.frames.delete(chunk.frameId);
    return str;
  }
}

module.exports = { encodeFrame, decodeFrame, chunkFrame, Reassembler, validateMessage };
