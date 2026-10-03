'use strict';

const { crc32 } = require('./crc32');

const FRAME_LEN = 29;
const MAGIC = 0x4658; // 'FX'

const TYPES = { OBLIGATION: 1, ACK: 2, NAK: 3, CANCEL: 4, TICK: 5 };
const TYPE_NAMES = { 1: 'OBLIGATION', 2: 'ACK', 3: 'NAK', 4: 'CANCEL', 5: 'TICK' };

const REASONS = {
  1: 'DUPLICATE',
  2: 'UNKNOWN_SEQ',
  3: 'BAD_AMOUNT',
  4: 'INSUFFICIENT_LIQUIDITY',
  5: 'LATE_DELIVERY',
};

class FrameError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
    this.exitCode = 2;
  }
}

// Frame layout (29 bytes, big-endian):
//   0  u16  magic 'FX'
//   2  u8   type (1=obligation 2=ack 3=nak 4=cancel 5=tick)
//   3  u32  cycle
//   7  u8   from (bank id)
//   8  u8   to   (bank id)
//   9  3    ccy  (ASCII, space padded)
//  12  i64  amount (signed; tick uses it as a positive ms delta)
//  20  u32  seq
//  24  u8   reason (nak only, 0 otherwise)
//  25  u32  crc32 over bytes [0,25)
function encodeFrame(f) {
  const buf = Buffer.alloc(FRAME_LEN);
  buf.writeUInt16BE(MAGIC, 0);
  buf.writeUInt8(f.type, 2);
  buf.writeUInt32BE(f.cycle >>> 0, 3);
  buf.writeUInt8(f.from, 7);
  buf.writeUInt8(f.to, 8);
  buf.write(String(f.ccy).padEnd(3, ' ').slice(0, 3), 9, 'ascii');
  buf.writeBigInt64BE(BigInt(f.amount), 12);
  buf.writeUInt32BE(f.seq >>> 0, 20);
  buf.writeUInt8(f.reason || 0, 24);
  buf.writeUInt32BE(crc32(buf.subarray(0, 25)), 25);
  return buf;
}

function decodeFrame(buf) {
  if (buf.length !== FRAME_LEN) {
    throw new FrameError(`bad frame length ${buf.length} (expected ${FRAME_LEN})`, 'BAD_LENGTH');
  }
  if (buf.readUInt16BE(0) !== MAGIC) {
    throw new FrameError('bad frame magic', 'BAD_MAGIC');
  }
  const expected = buf.readUInt32BE(25);
  const actual = crc32(buf.subarray(0, 25));
  if (actual !== expected) {
    throw new FrameError(`crc mismatch: computed ${actual}, frame carries ${expected}`, 'BAD_CRC');
  }
  const type = buf.readUInt8(2);
  if (!TYPE_NAMES[type]) {
    throw new FrameError(`unknown frame type ${type}`, 'BAD_TYPE');
  }
  return {
    type,
    cycle: buf.readUInt32BE(3),
    from: buf.readUInt8(7),
    to: buf.readUInt8(8),
    ccy: buf.toString('ascii', 9, 12).trim(),
    amount: buf.readBigInt64BE(12),
    seq: buf.readUInt32BE(20),
    reason: buf.readUInt8(24),
  };
}

module.exports = { FRAME_LEN, TYPES, TYPE_NAMES, REASONS, FrameError, encodeFrame, decodeFrame };
