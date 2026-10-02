'use strict';

// Binary frame layout (36 bytes, big-endian):
//   0..1   len      u16   total frame length, must equal 36
//   2      type     u8    1=RESERVE 2=COMMIT 3=RELEASE 4=EXPIRE
//   3      flags    u8    reserved, must be 0
//   4..11  member   8B    ASCII, NUL padded
//   12..15 reqId    u32
//   16..23 amount   u64   (for EXPIRE: target virtual timestamp)
//   24..27 seq      u32   per-member send sequence, starts at 1
//   28..31 ack      u32   informational
//   32..35 checksum u32   CRC32 over bytes 0..32

const FRAME_LEN = 36;
const TYPE = Object.freeze({ RESERVE: 1, COMMIT: 2, RELEASE: 3, EXPIRE: 4 });
const TYPE_NAME = Object.freeze({ 1: 'RESERVE', 2: 'COMMIT', 3: 'RELEASE', 4: 'EXPIRE' });

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

class FrameError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FrameError';
  }
}

function checkMember(member) {
  if (typeof member !== 'string' || !/^[A-Za-z0-9_]{1,8}$/.test(member)) {
    throw new FrameError(`invalid member name: ${JSON.stringify(member)}`);
  }
}

function encodeFrame({ type, member, reqId = 0, amount = 0, seq, ack = 0 }) {
  if (!TYPE_NAME[type]) throw new FrameError(`invalid type: ${type}`);
  checkMember(member);
  const buf = Buffer.alloc(FRAME_LEN);
  buf.writeUInt16BE(FRAME_LEN, 0);
  buf.writeUInt8(type, 2);
  buf.writeUInt8(0, 3);
  const mb = Buffer.alloc(8);
  mb.write(member, 0, 'ascii');
  mb.copy(buf, 4);
  buf.writeUInt32BE(reqId >>> 0, 12);
  buf.writeBigUInt64BE(BigInt(amount), 16);
  buf.writeUInt32BE(seq >>> 0, 24);
  buf.writeUInt32BE(ack >>> 0, 28);
  buf.writeUInt32BE(crc32(buf.subarray(0, 32)), 32);
  return buf;
}

function decodeFrame(buf) {
  if (buf.length !== FRAME_LEN) throw new FrameError(`bad frame length: ${buf.length}`);
  if (buf.readUInt16BE(0) !== FRAME_LEN) throw new FrameError(`bad len field: ${buf.readUInt16BE(0)}`);
  const expected = crc32(buf.subarray(0, 32));
  if (buf.readUInt32BE(32) !== expected) throw new FrameError('checksum mismatch');
  const type = buf.readUInt8(2);
  if (!TYPE_NAME[type]) throw new FrameError(`unknown type: ${type}`);
  if (buf.readUInt8(3) !== 0) throw new FrameError('flags must be 0');
  const member = buf.subarray(4, 12).toString('ascii').replace(/\0.*$/s, '');
  checkMember(member);
  return {
    type,
    member,
    reqId: buf.readUInt32BE(12),
    amount: Number(buf.readBigUInt64BE(16)),
    seq: buf.readUInt32BE(24),
    ack: buf.readUInt32BE(28),
  };
}

module.exports = { FRAME_LEN, TYPE, TYPE_NAME, FrameError, crc32, encodeFrame, decodeFrame };
