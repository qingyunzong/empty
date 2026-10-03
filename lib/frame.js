'use strict';

// Binary frame layout (all integers big-endian):
//
//   offset  size  field
//   0       2     magic = 0xC1EA
//   2       2     len   (total frame length, including the crc field; 38 for full frames)
//   4       1     type  (1=RESERVE 2=COMMIT 3=RELEASE 4=EXPIRE 5=FRAG)
//   5       1     flags (reserved, 0)
//   6       8     member (ASCII, NUL padded)
//   14      4     reqId  (uint32)
//   18      4     amount (uint32)
//   22      4     seq    (uint32, link-level sequence number)
//   26      4     ack    (uint32, highest seq acknowledged by the peer)
//   30      4     tick   (uint32, virtual clock value)
//   34      4     crc32  (IEEE, over bytes 0..34)
//
// A FRAG frame carries one chunk of a fragmented full frame:
//
//   0       2     magic
//   2       2     len   (= 22 + dataLen + 4)
//   4       1     type  = 5 (FRAG)
//   5       1     flags (reserved, 0)
//   6       8     member
//   14      4     seq    (seq of the original frame being fragmented)
//   18      2     offset (uint16, byte offset of data inside the original frame)
//   20      2     total  (uint16, total length of the original frame)
//   22      ..    data
//   ..      4     crc32  (over all preceding bytes)

const MAGIC = 0xc1ea;
const TYPE = Object.freeze({ RESERVE: 1, COMMIT: 2, RELEASE: 3, EXPIRE: 4, FRAG: 5 });
const TYPE_NAME = Object.freeze({ 1: 'reserve', 2: 'commit', 3: 'release', 4: 'expire', 5: 'frag' });
const FRAME_LEN = 38;
const FRAG_HEADER_LEN = 22;
const MEMBER_LEN = 8;
const UINT32_MAX = 0xffffffff;

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

class CorruptFrameError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CorruptFrameError';
    this.code = 'CORRUPT_FRAME';
  }
}

function checkUint32(name, value) {
  if (!Number.isInteger(value) || value < 0 || value > UINT32_MAX) {
    throw new RangeError(`${name} must be a uint32, got ${value}`);
  }
}

function encodeMember(member) {
  if (typeof member !== 'string' || member.length === 0 || member.length > MEMBER_LEN) {
    throw new RangeError(`member must be 1..${MEMBER_LEN} ASCII chars, got ${JSON.stringify(member)}`);
  }
  const buf = Buffer.alloc(MEMBER_LEN);
  for (let i = 0; i < member.length; i++) {
    const code = member.charCodeAt(i);
    if (code < 0x21 || code > 0x7e) throw new RangeError(`member must be printable ASCII: ${JSON.stringify(member)}`);
    buf[i] = code;
  }
  return buf;
}

function decodeMember(buf) {
  let end = 0;
  while (end < buf.length && buf[end] !== 0) end++;
  for (let i = 0; i < end; i++) {
    if (buf[i] < 0x21 || buf[i] > 0x7e) throw new CorruptFrameError('member is not printable ASCII');
  }
  return buf.subarray(0, end).toString('ascii');
}

function encodeFrame({ type, member, reqId, amount, seq, ack = 0, tick = 0, flags = 0 }) {
  if (!TYPE_NAME[type] || type === TYPE.FRAG) throw new RangeError(`invalid frame type ${type}`);
  checkUint32('reqId', reqId);
  checkUint32('amount', amount);
  checkUint32('seq', seq);
  checkUint32('ack', ack);
  checkUint32('tick', tick);
  const buf = Buffer.alloc(FRAME_LEN);
  buf.writeUInt16BE(MAGIC, 0);
  buf.writeUInt16BE(FRAME_LEN, 2);
  buf[4] = type;
  buf[5] = flags & 0xff;
  encodeMember(member).copy(buf, 6);
  buf.writeUInt32BE(reqId, 14);
  buf.writeUInt32BE(amount, 18);
  buf.writeUInt32BE(seq, 22);
  buf.writeUInt32BE(ack, 26);
  buf.writeUInt32BE(tick, 30);
  buf.writeUInt32BE(crc32(buf.subarray(0, 34)), 34);
  return buf;
}

function verifyRecord(record, expectLen) {
  if (record.length !== expectLen) {
    throw new CorruptFrameError(`record length ${record.length}, expected ${expectLen}`);
  }
  if (record.readUInt16BE(0) !== MAGIC) throw new CorruptFrameError('bad magic');
  if (record.readUInt16BE(2) !== expectLen) {
    throw new CorruptFrameError(`len field ${record.readUInt16BE(2)} != actual ${expectLen}`);
  }
  const body = record.subarray(0, record.length - 4);
  const want = record.readUInt32BE(record.length - 4);
  if (crc32(body) !== want) throw new CorruptFrameError('crc32 mismatch');
}

function decodeFrame(record) {
  verifyRecord(record, FRAME_LEN);
  const type = record[4];
  if (!TYPE_NAME[type] || type === TYPE.FRAG) throw new CorruptFrameError(`unknown frame type ${type}`);
  return {
    type,
    flags: record[5],
    member: decodeMember(record.subarray(6, 14)),
    reqId: record.readUInt32BE(14),
    amount: record.readUInt32BE(18),
    seq: record.readUInt32BE(22),
    ack: record.readUInt32BE(26),
    tick: record.readUInt32BE(30),
  };
}

function encodeFrag({ member, seq, offset, total, data }) {
  checkUint32('seq', seq);
  if (!Number.isInteger(offset) || offset < 0 || offset > 0xffff) throw new RangeError('bad frag offset');
  if (!Number.isInteger(total) || total <= 0 || total > 0xffff) throw new RangeError('bad frag total');
  if (!Buffer.isBuffer(data) || data.length === 0) throw new RangeError('frag data must be a non-empty Buffer');
  if (offset + data.length > total) throw new RangeError('frag data exceeds total');
  const buf = Buffer.alloc(FRAG_HEADER_LEN + data.length + 4);
  buf.writeUInt16BE(MAGIC, 0);
  buf.writeUInt16BE(buf.length, 2);
  buf[4] = TYPE.FRAG;
  buf[5] = 0;
  encodeMember(member).copy(buf, 6);
  buf.writeUInt32BE(seq, 14);
  buf.writeUInt16BE(offset, 18);
  buf.writeUInt16BE(total, 20);
  data.copy(buf, FRAG_HEADER_LEN);
  buf.writeUInt32BE(crc32(buf.subarray(0, buf.length - 4)), buf.length - 4);
  return buf;
}

function decodeFrag(record) {
  if (record.length < FRAG_HEADER_LEN + 4 + 1) throw new CorruptFrameError('frag record too short');
  verifyRecord(record, record.length);
  if (record[4] !== TYPE.FRAG) throw new CorruptFrameError('not a frag record');
  return {
    member: decodeMember(record.subarray(6, 14)),
    seq: record.readUInt32BE(14),
    offset: record.readUInt16BE(18),
    total: record.readUInt16BE(20),
    data: Buffer.from(record.subarray(FRAG_HEADER_LEN, record.length - 4)),
  };
}

function fragmentFrame(frameBuf, member, seq, chunkSize) {
  if (frameBuf.length !== FRAME_LEN) throw new RangeError('can only fragment full frames');
  const frags = [];
  for (let offset = 0; offset < frameBuf.length; offset += chunkSize) {
    frags.push(encodeFrag({
      member,
      seq,
      offset,
      total: frameBuf.length,
      data: frameBuf.subarray(offset, Math.min(offset + chunkSize, frameBuf.length)),
    }));
  }
  return frags;
}

module.exports = {
  MAGIC, TYPE, TYPE_NAME, FRAME_LEN, FRAG_HEADER_LEN, MEMBER_LEN,
  crc32, CorruptFrameError,
  encodeFrame, decodeFrame, encodeFrag, decodeFrag, fragmentFrame,
};
