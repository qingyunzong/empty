'use strict';

const { crc32 } = require('./crc32');

const BLOCK_MAGIC = Buffer.from('SBLK');
const INDEX_MAGIC = Buffer.from('SIDX');
const FOOTER_MAGIC = Buffer.from('SEND');

const HEADER_LEN = 24; // magic4 seq4 startOffset4 prevCrc4 blockLen4 payloadLen4
const CRC_LEN = 4;
const MIN_BLOCK_LEN = HEADER_LEN + CRC_LEN;
const INDEX_FIXED_LEN = 4 + 4 + CRC_LEN; // magic + count + crc
const INDEX_ENTRY_LEN = 8; // offset4 + length4
const FOOTER_LEN = 8; // magic4 + indexLen4

function encodeBlock({ seq, startOffset, prevCrc, payload }) {
  const blockLen = MIN_BLOCK_LEN + payload.length;
  const buf = Buffer.alloc(blockLen);
  BLOCK_MAGIC.copy(buf, 0);
  buf.writeUInt32LE(seq, 4);
  buf.writeUInt32LE(startOffset, 8);
  buf.writeUInt32LE(prevCrc, 12);
  buf.writeUInt32LE(blockLen, 16);
  buf.writeUInt32LE(payload.length, 20);
  payload.copy(buf, HEADER_LEN);
  buf.writeUInt32LE(crc32(buf.subarray(0, HEADER_LEN + payload.length)), HEADER_LEN + payload.length);
  return buf;
}

// Returns { seq, startOffset, prevCrc, blockLen, payload, crc } or throws Error with .reason
function decodeBlock(buf, offset = 0) {
  if (buf.length - offset < MIN_BLOCK_LEN) {
    throw Object.assign(new Error('truncated block header'), { reason: 'truncated' });
  }
  if (!buf.subarray(offset, offset + 4).equals(BLOCK_MAGIC)) {
    throw Object.assign(new Error('bad block magic'), { reason: 'magic' });
  }
  const seq = buf.readUInt32LE(offset + 4);
  const startOffset = buf.readUInt32LE(offset + 8);
  const prevCrc = buf.readUInt32LE(offset + 12);
  const blockLen = buf.readUInt32LE(offset + 16);
  const payloadLen = buf.readUInt32LE(offset + 20);
  if (blockLen !== MIN_BLOCK_LEN + payloadLen) {
    throw Object.assign(new Error('block length mismatch'), { reason: 'length' });
  }
  if (buf.length - offset < blockLen) {
    throw Object.assign(new Error('truncated block body'), { reason: 'truncated' });
  }
  const body = buf.subarray(offset, offset + blockLen);
  const storedCrc = body.readUInt32LE(blockLen - CRC_LEN);
  const crc = crc32(body.subarray(0, blockLen - CRC_LEN));
  if (crc !== storedCrc) {
    throw Object.assign(new Error('block crc mismatch'), { reason: 'crc' });
  }
  return {
    seq,
    startOffset,
    prevCrc,
    blockLen,
    payload: Buffer.from(body.subarray(HEADER_LEN, blockLen - CRC_LEN)),
    crc,
  };
}

function encodeIndex(entries) {
  const buf = Buffer.alloc(INDEX_FIXED_LEN + entries.length * INDEX_ENTRY_LEN);
  INDEX_MAGIC.copy(buf, 0);
  buf.writeUInt32LE(entries.length, 4);
  entries.forEach((e, i) => {
    buf.writeUInt32LE(e.offset, 8 + i * INDEX_ENTRY_LEN);
    buf.writeUInt32LE(e.length, 8 + i * INDEX_ENTRY_LEN + 4);
  });
  buf.writeUInt32LE(crc32(buf.subarray(0, buf.length - CRC_LEN)), buf.length - CRC_LEN);
  return buf;
}

function encodeFooter(indexLen) {
  const buf = Buffer.alloc(FOOTER_LEN);
  FOOTER_MAGIC.copy(buf, 0);
  buf.writeUInt32LE(indexLen, 4);
  return buf;
}

// Parses index+footer located exactly at `offset` within buf and spanning to buf.length.
// Returns entries array, or null if the bytes are not a well-formed index+footer.
function tryParseIndexAt(buf, offset) {
  const len = buf.length - offset;
  if (len < INDEX_FIXED_LEN + FOOTER_LEN) return null;
  const footer = buf.subarray(buf.length - FOOTER_LEN);
  if (!footer.subarray(0, 4).equals(FOOTER_MAGIC)) return null;
  const indexLen = footer.readUInt32LE(4);
  if (indexLen !== len - FOOTER_LEN) return null;
  const idx = buf.subarray(offset, offset + indexLen);
  if (!idx.subarray(0, 4).equals(INDEX_MAGIC)) return null;
  const count = idx.readUInt32LE(4);
  if (indexLen !== INDEX_FIXED_LEN + count * INDEX_ENTRY_LEN) return null;
  const storedCrc = idx.readUInt32LE(indexLen - CRC_LEN);
  if (crc32(idx.subarray(0, indexLen - CRC_LEN)) !== storedCrc) return null;
  const entries = [];
  for (let i = 0; i < count; i++) {
    entries.push({
      offset: idx.readUInt32LE(8 + i * INDEX_ENTRY_LEN),
      length: idx.readUInt32LE(8 + i * INDEX_ENTRY_LEN + 4),
    });
  }
  return entries;
}

module.exports = {
  BLOCK_MAGIC,
  INDEX_MAGIC,
  FOOTER_MAGIC,
  HEADER_LEN,
  CRC_LEN,
  MIN_BLOCK_LEN,
  INDEX_FIXED_LEN,
  INDEX_ENTRY_LEN,
  FOOTER_LEN,
  encodeBlock,
  decodeBlock,
  encodeIndex,
  encodeFooter,
  tryParseIndexAt,
};
