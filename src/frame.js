'use strict';

const { crc32 } = require('./crc32');

const MAGIC = Buffer.from([0x41, 0x54]); // 'AT'
const VERSION = 1;
const TYPE_OP = 1;
const ZERO_HASH = '0'.repeat(64);

class FrameError extends Error {
  constructor(message) {
    super(message);
    this.code = 'FRAME_ERROR';
  }
}

function opIdBytes(opId) {
  if (Buffer.isBuffer(opId)) {
    if (opId.length !== 16) throw new FrameError('opId must be 16 bytes');
    return opId;
  }
  const hex = String(opId);
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new FrameError('opId must be 32 hex chars');
  return Buffer.from(hex, 'hex');
}

function encodeFrame({ opId, actor, cmd, args = {}, prevHash = ZERO_HASH, seq, leaseUntil }) {
  const actorBuf = Buffer.from(String(actor), 'utf8');
  const cmdBuf = Buffer.from(String(cmd), 'utf8');
  const argsBuf = Buffer.from(JSON.stringify(args), 'utf8');
  if (actorBuf.length > 255) throw new FrameError('actor too long');
  if (cmdBuf.length > 255) throw new FrameError('cmd too long');
  if (argsBuf.length > 0xffff) throw new FrameError('args too long');
  const prev = Buffer.from(prevHash, 'hex');
  if (prev.length !== 32) throw new FrameError('prevHash must be 32 bytes');

  const body = Buffer.alloc(2 + 1 + 1 + 16 + 1 + actorBuf.length + 1 + cmdBuf.length + 2 + argsBuf.length + 32 + 8 + 8);
  let o = 0;
  MAGIC.copy(body, o); o += 2;
  body.writeUInt8(VERSION, o); o += 1;
  body.writeUInt8(TYPE_OP, o); o += 1;
  opIdBytes(opId).copy(body, o); o += 16;
  body.writeUInt8(actorBuf.length, o); o += 1;
  actorBuf.copy(body, o); o += actorBuf.length;
  body.writeUInt8(cmdBuf.length, o); o += 1;
  cmdBuf.copy(body, o); o += cmdBuf.length;
  body.writeUInt16BE(argsBuf.length, o); o += 2;
  argsBuf.copy(body, o); o += argsBuf.length;
  prev.copy(body, o); o += 32;
  body.writeBigUInt64BE(BigInt(seq), o); o += 8;
  body.writeBigUInt64BE(BigInt(leaseUntil), o); o += 8;
  const crc = crc32(body);
  const frame = Buffer.alloc(body.length + 4);
  body.copy(frame, 0);
  frame.writeUInt32BE(crc, body.length);
  return frame;
}

// Returns { frame, raw, consumed } or null when more bytes are needed.
function tryDecodeFrame(buf, offset = 0) {
  const need = (n) => buf.length - offset >= n;
  if (!need(2)) return null;
  if (buf[offset] !== MAGIC[0] || buf[offset + 1] !== MAGIC[1]) throw new FrameError('bad magic');
  if (!need(4)) return null;
  if (buf[offset + 2] !== VERSION) throw new FrameError('bad version');
  if (buf[offset + 3] !== TYPE_OP) throw new FrameError('unknown frame type');
  if (!need(20)) return null;
  let o = offset + 20;
  if (!need(o - offset + 1)) return null;
  const actorLen = buf[o]; o += 1;
  if (!need(o - offset + actorLen + 1)) return null;
  const actor = buf.toString('utf8', o, o + actorLen); o += actorLen;
  const cmdLen = buf[o]; o += 1;
  if (!need(o - offset + cmdLen + 2)) return null;
  const cmd = buf.toString('utf8', o, o + cmdLen); o += cmdLen;
  const argsLen = buf.readUInt16BE(o); o += 2;
  if (!need(o - offset + argsLen + 32 + 16 + 4)) return null;
  const argsRaw = buf.toString('utf8', o, o + argsLen); o += argsLen;
  const prevHash = buf.toString('hex', o, o + 32); o += 32;
  const seq = Number(buf.readBigUInt64BE(o)); o += 8;
  const leaseUntil = Number(buf.readBigUInt64BE(o)); o += 8;
  const crcExpected = buf.readUInt32BE(o); o += 4;
  const crcActual = crc32(buf.subarray(offset, o - 4));
  if (crcActual !== crcExpected) throw new FrameError(`crc mismatch: expected ${crcExpected.toString(16)}, got ${crcActual.toString(16)}`);
  let args;
  try {
    args = JSON.parse(argsRaw);
  } catch {
    throw new FrameError('args is not valid JSON');
  }
  return {
    frame: { opId: buf.toString('hex', offset + 4, offset + 20), actor, cmd, args, prevHash, seq, leaseUntil },
    raw: buf.subarray(offset, o),
    consumed: o - offset,
  };
}

// Streaming parser: tolerates arbitrary fragmentation of the byte stream.
class FrameParser {
  constructor() {
    this.buf = Buffer.alloc(0);
  }
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
    const out = [];
    for (;;) {
      const r = tryDecodeFrame(this.buf, 0);
      if (!r) break;
      out.push(r);
      this.buf = this.buf.subarray(r.consumed);
    }
    return out;
  }
  get pendingBytes() {
    return this.buf.length;
  }
}

module.exports = { encodeFrame, tryDecodeFrame, FrameParser, FrameError, ZERO_HASH, TYPE_OP, VERSION };
