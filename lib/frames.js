'use strict';
const { canon, crc32hex } = require('./util');

const MAX_FRAME = 1 << 20;

class FrameError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FrameError';
    this.exitCode = 2;
  }
}

function payloadChecksum(obj) {
  const rest = { ...obj };
  delete rest.checksum;
  return crc32hex(canon(rest));
}

function encodeFrame(obj) {
  const body = Buffer.from(JSON.stringify({ ...obj, checksum: payloadChecksum(obj) }), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length, 0);
  return Buffer.concat([len, body]);
}

function encodeStream(objs) {
  return Buffer.concat(objs.map(encodeFrame));
}

// Decodes as many complete frames as possible. A trailing partial frame is
// returned as `tail` (tolerated, reported by caller); malformed frames throw.
function decodeStream(buf) {
  const frames = [];
  let off = 0;
  while (off < buf.length) {
    if (buf.length - off < 4) return { frames, tail: buf.slice(off) };
    const len = buf.readUInt32BE(off);
    if (len < 2 || len > MAX_FRAME) {
      throw new FrameError(`invalid frame length ${len} at byte offset ${off}`);
    }
    if (buf.length - off - 4 < len) return { frames, tail: buf.slice(off) };
    const raw = buf.slice(off, off + 4 + len);
    let obj;
    try {
      obj = JSON.parse(raw.slice(4).toString('utf8'));
    } catch {
      throw new FrameError(`invalid JSON payload at byte offset ${off}`);
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      throw new FrameError(`frame payload must be a JSON object at byte offset ${off}`);
    }
    if (typeof obj.checksum !== 'string' || obj.checksum !== payloadChecksum(obj)) {
      throw new FrameError(`checksum mismatch at byte offset ${off}`);
    }
    frames.push({ raw, obj });
    off += 4 + len;
  }
  return { frames, tail: Buffer.alloc(0) };
}

function decodeOne(raw) {
  return decodeStream(raw).frames[0].obj;
}

module.exports = { FrameError, encodeFrame, encodeStream, decodeStream, decodeOne, payloadChecksum };
