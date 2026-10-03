'use strict';
// Wire format for the FX bilateral netting queue.
//
// File layout (frames.bin):
//   4 bytes  magic 'FXB1'
//   1 byte   version (=1)
//   2 bytes  bankCount (u16 BE)
//   bankCount * (4 bytes bank id, 3 bytes ccy, 8 bytes i64 BE balance)
//   then link packets until EOF
//
// Link packet:
//   2 bytes  magic 'FQ'
//   4 bytes  linkSeq (u32 BE)   transport sequence, used for dedup + reorder
//   2 bytes  fragId  (u16 BE)   fragments of one frame share a fragId
//   1 byte   fragIndex (u8)
//   1 byte   fragCount (u8)
//   2 bytes  payloadLen (u16 BE)
//   payloadLen bytes payload
//   2 bytes  crc16 over magic..payload
//
// Frame (reassembled payload), fixed 31 bytes:
//   1 byte   type (1=OBLIGATION 2=ACK 3=NAK 4=CANCEL)
//   4 bytes  cycle (u32 BE)
//   4 bytes  from (ascii, space padded)
//   4 bytes  to   (ascii, space padded)
//   3 bytes  ccy  (ascii)
//   8 bytes  amount (i64 BE, minor units)
//   4 bytes  seq (u32 BE, per-sender message id)
//   1 byte   reason (nak only, 0 = none)
//   2 bytes  crc16 over the preceding 29 bytes

const FRAME_TYPES = { OBLIGATION: 1, ACK: 2, NAK: 3, CANCEL: 4 };
const FRAME_TYPE_NAMES = { 1: 'OBLIGATION', 2: 'ACK', 3: 'NAK', 4: 'CANCEL' };
const REASONS = {
  1: 'INSUFFICIENT_LIQUIDITY',
  2: 'DUPLICATE',
  3: 'NOT_FOUND',
  4: 'CYCLE_CLOSED',
  5: 'VALIDATION',
  6: 'AMOUNT_INVALID',
};

const FILE_MAGIC = Buffer.from('FXB1');
const PKT_MAGIC = Buffer.from('FQ');
const FRAME_LEN = 31;
const PKT_HEADER_LEN = 12;

class ValidationError extends Error {
  constructor(msg) { super(msg); this.name = 'ValidationError'; this.exitCode = 2; }
}

function crc16(buf) {
  let crc = 0xffff;
  for (const byte of buf) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function writeId(buf, id, offset, len) {
  if (typeof id !== 'string' || id.length < 1 || id.length > len) {
    throw new ValidationError(`bad id '${id}'`);
  }
  buf.fill(0x20, offset, offset + len);
  buf.write(id, offset, 'ascii');
}

function readId(buf, offset, len) {
  return buf.subarray(offset, offset + len).toString('ascii').trim();
}

function encodeFrame(f) {
  const buf = Buffer.alloc(FRAME_LEN);
  let o = 0;
  buf.writeUInt8(f.type, o); o += 1;
  buf.writeUInt32BE(f.cycle >>> 0, o); o += 4;
  writeId(buf, f.from, o, 4); o += 4;
  writeId(buf, f.to, o, 4); o += 4;
  writeId(buf, f.ccy, o, 3); o += 3;
  buf.writeBigInt64BE(BigInt(f.amount), o); o += 8;
  buf.writeUInt32BE(f.seq >>> 0, o); o += 4;
  buf.writeUInt8(f.reason || 0, o); o += 1;
  buf.writeUInt16BE(crc16(buf.subarray(0, o)), o);
  return buf;
}

const ID_RE = /^[A-Z0-9]{1,4}$/;
const CCY_RE = /^[A-Z]{3}$/;

function decodeFrame(buf) {
  if (buf.length !== FRAME_LEN) {
    throw new ValidationError(`frame length ${buf.length}, expected ${FRAME_LEN}`);
  }
  const body = buf.subarray(0, FRAME_LEN - 2);
  const want = buf.readUInt16BE(FRAME_LEN - 2);
  const got = crc16(body);
  if (want !== got) {
    throw new ValidationError(`frame crc mismatch: got 0x${got.toString(16)}, want 0x${want.toString(16)}`);
  }
  let o = 0;
  const type = buf.readUInt8(o); o += 1;
  if (!FRAME_TYPE_NAMES[type]) throw new ValidationError(`unknown frame type ${type}`);
  const cycle = buf.readUInt32BE(o); o += 4;
  const from = readId(buf, o, 4); o += 4;
  const to = readId(buf, o, 4); o += 4;
  const ccy = readId(buf, o, 3); o += 3;
  const amount = buf.readBigInt64BE(o); o += 8;
  const seq = buf.readUInt32BE(o); o += 4;
  const reason = buf.readUInt8(o); o += 1;
  if (!ID_RE.test(from)) throw new ValidationError(`bad from id '${from}'`);
  if (!ID_RE.test(to)) throw new ValidationError(`bad to id '${to}'`);
  if (!CCY_RE.test(ccy)) throw new ValidationError(`bad ccy '${ccy}'`);
  return { type, cycle, from, to, ccy, amount, seq, reason };
}

function encodePacket({ linkSeq, fragId, fragIndex, fragCount, payload }) {
  const buf = Buffer.alloc(PKT_HEADER_LEN + payload.length + 2);
  let o = 0;
  PKT_MAGIC.copy(buf, o); o += 2;
  buf.writeUInt32BE(linkSeq >>> 0, o); o += 4;
  buf.writeUInt16BE(fragId & 0xffff, o); o += 2;
  buf.writeUInt8(fragIndex, o); o += 1;
  buf.writeUInt8(fragCount, o); o += 1;
  buf.writeUInt16BE(payload.length, o); o += 2;
  payload.copy(buf, o); o += payload.length;
  buf.writeUInt16BE(crc16(buf.subarray(0, o)), o);
  return buf;
}

function decodePacket(buf, offset) {
  if (offset + PKT_HEADER_LEN + 2 > buf.length) {
    throw new ValidationError(`truncated packet at offset ${offset}`);
  }
  if (!buf.subarray(offset, offset + 2).equals(PKT_MAGIC)) {
    throw new ValidationError(`bad packet magic at offset ${offset}`);
  }
  const linkSeq = buf.readUInt32BE(offset + 2);
  const fragId = buf.readUInt16BE(offset + 6);
  const fragIndex = buf.readUInt8(offset + 8);
  const fragCount = buf.readUInt8(offset + 9);
  const payloadLen = buf.readUInt16BE(offset + 10);
  const end = offset + PKT_HEADER_LEN + payloadLen;
  if (end + 2 > buf.length) {
    throw new ValidationError(`truncated packet payload at offset ${offset}`);
  }
  const want = buf.readUInt16BE(end);
  const got = crc16(buf.subarray(offset, end));
  if (want !== got) {
    throw new ValidationError(`packet crc mismatch at offset ${offset} (linkSeq=${linkSeq})`);
  }
  if (fragCount === 0 || fragIndex >= fragCount) {
    throw new ValidationError(`bad fragment coords ${fragIndex}/${fragCount} (linkSeq=${linkSeq})`);
  }
  const payload = buf.subarray(offset + PKT_HEADER_LEN, end);
  return { packet: { linkSeq, fragId, fragIndex, fragCount, payload }, next: end + 2 };
}

function buildFile({ banks, packets }) {
  const head = Buffer.alloc(4 + 1 + 2);
  FILE_MAGIC.copy(head, 0);
  head.writeUInt8(1, 4);
  head.writeUInt16BE(banks.length, 5);
  const parts = [head];
  for (const b of banks) {
    const rec = Buffer.alloc(4 + 3 + 8);
    writeId(rec, b.id, 0, 4);
    writeId(rec, b.ccy, 4, 3);
    rec.writeBigInt64BE(BigInt(b.balance), 7);
    parts.push(rec);
  }
  return Buffer.concat([...parts, ...packets]);
}

function parseFile(buf) {
  if (buf.length < 7 || !buf.subarray(0, 4).equals(FILE_MAGIC)) {
    throw new ValidationError('bad file magic');
  }
  if (buf.readUInt8(4) !== 1) throw new ValidationError('unsupported version');
  const bankCount = buf.readUInt16BE(5);
  let offset = 7;
  const banks = [];
  for (let i = 0; i < bankCount; i++) {
    if (offset + 15 > buf.length) throw new ValidationError('truncated bank table');
    const id = readId(buf, offset, 4);
    const ccy = readId(buf, offset + 4, 3);
    const balance = buf.readBigInt64BE(offset + 7);
    if (!ID_RE.test(id)) throw new ValidationError(`bad bank id '${id}'`);
    if (!CCY_RE.test(ccy)) throw new ValidationError(`bad bank ccy '${ccy}'`);
    banks.push({ id, ccy, balance });
    offset += 15;
  }
  const packets = [];
  while (offset < buf.length) {
    const { packet, next } = decodePacket(buf, offset);
    packets.push(packet);
    offset = next;
  }
  return { banks, packets };
}

// Link layer: dedup retransmissions by linkSeq, reorder, reassemble fragments.
function reassemble(packets, log) {
  const bySeq = new Map();
  for (const p of packets) {
    if (bySeq.has(p.linkSeq)) {
      log.push(`[link] retransmission deduped linkSeq=${p.linkSeq}`);
      continue;
    }
    bySeq.set(p.linkSeq, p);
  }
  const ordered = [...bySeq.values()].sort((a, b) => a.linkSeq - b.linkSeq);
  const groups = new Map();
  for (const p of ordered) {
    let g = groups.get(p.fragId);
    if (!g) {
      g = { fragCount: p.fragCount, parts: new Map(), firstSeq: p.linkSeq };
      groups.set(p.fragId, g);
    }
    if (g.fragCount !== p.fragCount) {
      throw new ValidationError(`inconsistent fragCount for fragId=${p.fragId}`);
    }
    if (g.parts.has(p.fragIndex)) {
      throw new ValidationError(`duplicate fragment ${p.fragIndex} for fragId=${p.fragId}`);
    }
    g.parts.set(p.fragIndex, p.payload);
    g.firstSeq = Math.min(g.firstSeq, p.linkSeq);
  }
  const sortedGroups = [...groups.values()].sort((a, b) => a.firstSeq - b.firstSeq);
  const frames = [];
  for (const g of sortedGroups) {
    if (g.parts.size !== g.fragCount) {
      throw new ValidationError(`missing fragments: have ${g.parts.size}/${g.fragCount}`);
    }
    const parts = [];
    for (let i = 0; i < g.fragCount; i++) parts.push(g.parts.get(i));
    frames.push(Buffer.concat(parts));
  }
  return frames;
}

// Helper for tests/tools: split a frame buffer into fragment payloads.
function fragment(frameBuf, sizes) {
  const parts = [];
  let off = 0;
  for (const s of sizes) {
    parts.push(frameBuf.subarray(off, off + s));
    off += s;
  }
  if (off !== frameBuf.length) throw new Error('fragment sizes do not cover frame');
  return parts;
}

module.exports = {
  FRAME_TYPES, FRAME_TYPE_NAMES, REASONS,
  ValidationError, crc16,
  encodeFrame, decodeFrame, encodePacket, decodePacket,
  buildFile, parseFile, reassemble, fragment,
};
