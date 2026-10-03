'use strict';

const crypto = require('node:crypto');
const { FrameError } = require('./errors');

const MAX_FRAME_BYTES = 1 << 20;

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

function eventChecksum(ev) {
  const h = crypto.createHash('sha256');
  h.update([
    ev.eventId,
    ev.acct,
    String(ev.amount),
    String(ev.branchSeq),
    String(ev.logicalTs),
    ev.reversalOf || '',
    ev.replaces || '',
  ].join('|'));
  return h.digest('hex').slice(0, 16);
}

function withChecksum(ev) {
  return Object.assign({}, ev, { type: 'event', checksum: eventChecksum(ev) });
}

function validateEvent(ev) {
  if (typeof ev.eventId !== 'string' || ev.eventId.length === 0) {
    throw new FrameError('eventId must be a non-empty string');
  }
  if (typeof ev.acct !== 'string' || ev.acct.length === 0) {
    throw new FrameError(`event ${ev.eventId}: acct must be a non-empty string`);
  }
  if (!Number.isSafeInteger(ev.amount)) {
    throw new FrameError(`event ${ev.eventId}: amount must be a safe integer`);
  }
  if (!Number.isSafeInteger(ev.branchSeq) || ev.branchSeq < 1) {
    throw new FrameError(`event ${ev.eventId}: branchSeq must be a positive integer`);
  }
  if (!Number.isSafeInteger(ev.logicalTs) || ev.logicalTs < 0) {
    throw new FrameError(`event ${ev.eventId}: logicalTs must be a non-negative integer`);
  }
  if (ev.reversalOf !== undefined && typeof ev.reversalOf !== 'string') {
    throw new FrameError(`event ${ev.eventId}: reversalOf must be a string`);
  }
  if (ev.replaces !== undefined && typeof ev.replaces !== 'string') {
    throw new FrameError(`event ${ev.eventId}: replaces must be a string`);
  }
  if (typeof ev.checksum !== 'string' || ev.checksum !== eventChecksum(ev)) {
    throw new FrameError(`event ${ev.eventId}: checksum mismatch`);
  }
}

function encodeFrame(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}

function encodeFrames(objs) {
  return Buffer.concat(objs.map(encodeFrame));
}

// Parses a whole buffer of concatenated length-prefixed frames.
// Any framing violation (bad length, truncated/half frame, bad JSON) throws FrameError.
function decodeFrames(buf) {
  const frames = [];
  let off = 0;
  while (off < buf.length) {
    if (buf.length - off < 4) {
      throw new FrameError(`truncated frame header at offset ${off} (${buf.length - off} byte(s) left)`);
    }
    const len = buf.readUInt32BE(off);
    if (len < 1 || len > MAX_FRAME_BYTES) {
      throw new FrameError(`invalid frame length ${len} at offset ${off}`);
    }
    if (buf.length - off - 4 < len) {
      throw new FrameError(`half frame at offset ${off}: want ${len} bytes, have ${buf.length - off - 4}`);
    }
    const raw = buf.subarray(off + 4, off + 4 + len);
    let obj;
    try {
      obj = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new FrameError(`invalid JSON payload at offset ${off}`);
    }
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
      throw new FrameError(`frame at offset ${off} is not a JSON object`);
    }
    frames.push({ obj, raw });
    off += 4 + len;
  }
  return frames;
}

module.exports = {
  MAX_FRAME_BYTES,
  stableStringify,
  eventChecksum,
  withChecksum,
  validateEvent,
  encodeFrame,
  encodeFrames,
  decodeFrames,
};
