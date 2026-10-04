'use strict';
const { crc32 } = require('./util');

const MAGIC = 0x4154; // 'AT'
const VERSION = 1;
// magic(2) len(4) version(1) actorLen(1) cmdLen(1) opId(16) seq(8) ack(8) leaseUntil(8) prevHash(32) argsLen(2)
const FIXED_LEN = 2 + 4 + 1 + 1 + 1 + 16 + 8 + 8 + 8 + 32 + 2;
const CRC_LEN = 4;
const MAX_FRAME = 1 << 20;

class FrameError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'FrameError';
    this.reason = reason;
  }
}

function encodeFrame(f) {
  const opIdBuf = Buffer.from(f.opId, 'hex');
  if (opIdBuf.length !== 16) throw new FrameError('bad_opId');
  const prevHashBuf = Buffer.from(f.prevHash, 'hex');
  if (prevHashBuf.length !== 32) throw new FrameError('bad_prevHash');
  const actorBuf = Buffer.from(f.actor, 'utf8');
  const cmdBuf = Buffer.from(f.cmd, 'utf8');
  if (actorBuf.length > 255 || cmdBuf.length > 255) throw new FrameError('field_too_long');
  const argsBuf = Buffer.from(JSON.stringify(f.args === undefined ? {} : f.args), 'utf8');
  if (argsBuf.length > 65535) throw new FrameError('args_too_long');
  const total = FIXED_LEN + actorBuf.length + cmdBuf.length + argsBuf.length + CRC_LEN;
  const buf = Buffer.alloc(total);
  let o = 0;
  buf.writeUInt16BE(MAGIC, o); o += 2;
  buf.writeUInt32BE(total, o); o += 4;
  buf.writeUInt8(VERSION, o); o += 1;
  buf.writeUInt8(actorBuf.length, o); o += 1;
  buf.writeUInt8(cmdBuf.length, o); o += 1;
  opIdBuf.copy(buf, o); o += 16;
  buf.writeBigUInt64BE(BigInt(f.seq), o); o += 8;
  buf.writeBigUInt64BE(BigInt(f.ack === undefined ? 0 : f.ack), o); o += 8;
  buf.writeBigUInt64BE(BigInt(f.leaseUntil), o); o += 8;
  prevHashBuf.copy(buf, o); o += 32;
  buf.writeUInt16BE(argsBuf.length, o); o += 2;
  actorBuf.copy(buf, o); o += actorBuf.length;
  cmdBuf.copy(buf, o); o += cmdBuf.length;
  argsBuf.copy(buf, o); o += argsBuf.length;
  buf.writeUInt32BE(crc32(buf.subarray(0, o)), o);
  return buf;
}

function decodeFrame(buf) {
  if (buf.length < FIXED_LEN + CRC_LEN) throw new FrameError('frame_too_short');
  if (buf.readUInt16BE(0) !== MAGIC) throw new FrameError('bad_magic');
  if (buf.readUInt32BE(2) !== buf.length) throw new FrameError('bad_length');
  if (buf.readUInt8(6) !== VERSION) throw new FrameError('bad_version');
  const crc = buf.readUInt32BE(buf.length - CRC_LEN);
  if (crc32(buf.subarray(0, buf.length - CRC_LEN)) !== crc) throw new FrameError('bad_crc');
  const actorLen = buf.readUInt8(7);
  const cmdLen = buf.readUInt8(8);
  let o = 9;
  const opId = buf.subarray(o, o + 16).toString('hex'); o += 16;
  const seq = Number(buf.readBigUInt64BE(o)); o += 8;
  const ack = Number(buf.readBigUInt64BE(o)); o += 8;
  const leaseUntil = Number(buf.readBigUInt64BE(o)); o += 8;
  const prevHash = buf.subarray(o, o + 32).toString('hex'); o += 32;
  const argsLen = buf.readUInt16BE(o); o += 2;
  if (o + actorLen + cmdLen + argsLen + CRC_LEN !== buf.length) throw new FrameError('bad_section_lengths');
  const actor = buf.subarray(o, o + actorLen).toString('utf8'); o += actorLen;
  const cmd = buf.subarray(o, o + cmdLen).toString('utf8'); o += cmdLen;
  let args;
  try {
    args = JSON.parse(buf.subarray(o, o + argsLen).toString('utf8'));
  } catch {
    throw new FrameError('bad_args_json');
  }
  return { opId, actor, cmd, args, prevHash, seq, ack, leaseUntil };
}

// Incremental reassembler: frames may arrive fragmented across arbitrary chunk
// boundaries; push() yields only complete, CRC-valid frames.
class FrameStream {
  constructor() {
    this.buf = Buffer.alloc(0);
  }
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out = [];
    for (;;) {
      if (this.buf.length < 6) break;
      if (this.buf.readUInt16BE(0) !== MAGIC) throw new FrameError('bad_magic');
      const total = this.buf.readUInt32BE(2);
      if (total < FIXED_LEN + CRC_LEN || total > MAX_FRAME) throw new FrameError('bad_length');
      if (this.buf.length < total) break;
      const raw = this.buf.subarray(0, total);
      out.push({ frame: decodeFrame(raw), raw });
      this.buf = this.buf.subarray(total);
    }
    return out;
  }
  end() {
    if (this.buf.length !== 0) throw new FrameError('truncated_frame');
  }
}

module.exports = { encodeFrame, decodeFrame, FrameStream, FrameError, MAGIC, VERSION };
