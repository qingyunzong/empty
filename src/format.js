// Binary layout (all integers little-endian).
//
// Block:
//   0   magic "LGB1"            4
//   4   blockLength  uint32     total bytes of this block (header + payload + crc)
//   8   seq          uint32     0-based block sequence number
//   12  startOffset  uint64     absolute file offset where this block begins
//   20  endOffset    uint64     absolute file offset just past this block
//   28  prevCrc      uint32     stored CRC32 of the previous block (0 for block 0)
//   32  txCount      uint32
//   36  tx records   variable
//   len-4 crc32      uint32     CRC32 over bytes [0, len-4)
//
// Tx record:
//   txidLen uint8, txid utf8, kind uint8, amount uint64, targetLen uint8, target utf8
//
// Index file (<dat>.idx):
//   0 magic "LGI1" 4, 4 count uint32, then count entries of 20 bytes:
//   seq uint32, offset uint64, length uint32, crc uint32

import { crc32 } from './crc32.js';

export const BLOCK_MAGIC = Buffer.from('LGB1');
export const INDEX_MAGIC = Buffer.from('LGI1');
export const HEADER_LEN = 36;
export const CRC_LEN = 4;
export const MIN_BLOCK_LEN = HEADER_LEN + CRC_LEN;
export const INDEX_HEADER_LEN = 8;
export const INDEX_ENTRY_LEN = 20;

export const KIND = Object.freeze({ credit: 1, debit: 2, cancel: 3, freeze: 4, settle: 5 });
export const KIND_NAME = Object.freeze(
  Object.fromEntries(Object.entries(KIND).map(([name, id]) => [id, name]))
);

export class CorruptError extends Error {
  constructor(block, message) {
    super(message);
    this.name = 'CorruptError';
    this.code = 'CORRUPT_BLOCK';
    this.block = block;
    this.exitCode = 2;
  }
}

export function encodeTx(tx) {
  const id = Buffer.from(tx.txid, 'utf8');
  const target = tx.target ? Buffer.from(tx.target, 'utf8') : Buffer.alloc(0);
  if (id.length > 255 || target.length > 255) {
    throw new RangeError('txid/target longer than 255 bytes');
  }
  const buf = Buffer.alloc(1 + id.length + 1 + 8 + 1 + target.length);
  let o = 0;
  buf.writeUInt8(id.length, o); o += 1;
  id.copy(buf, o); o += id.length;
  buf.writeUInt8(tx.kind, o); o += 1;
  buf.writeBigUInt64LE(BigInt(tx.amount ?? 0), o); o += 8;
  buf.writeUInt8(target.length, o); o += 1;
  target.copy(buf, o);
  return buf;
}

export function encodeBlock({ seq, startOffset, prevCrc, txs }) {
  const parts = txs.map(encodeTx);
  const payloadLen = parts.reduce((n, p) => n + p.length, 0);
  const length = MIN_BLOCK_LEN + payloadLen;
  const buf = Buffer.alloc(length);
  BLOCK_MAGIC.copy(buf, 0);
  buf.writeUInt32LE(length, 4);
  buf.writeUInt32LE(seq, 8);
  buf.writeBigUInt64LE(BigInt(startOffset), 12);
  buf.writeBigUInt64LE(BigInt(startOffset + length), 20);
  buf.writeUInt32LE(prevCrc >>> 0, 28);
  buf.writeUInt32LE(txs.length, 32);
  let o = HEADER_LEN;
  for (const p of parts) { p.copy(buf, o); o += p.length; }
  const crc = crc32(buf.subarray(0, length - CRC_LEN));
  buf.writeUInt32LE(crc, length - CRC_LEN);
  return buf;
}

function decodeTx(buf, o, end, seq) {
  if (o + 1 > end) throw new CorruptError(seq, 'tx record overruns block payload');
  const idLen = buf.readUInt8(o); o += 1;
  if (o + idLen + 1 + 8 + 1 > end) throw new CorruptError(seq, 'tx record overruns block payload');
  const txid = buf.toString('utf8', o, o + idLen); o += idLen;
  const kind = buf.readUInt8(o); o += 1;
  if (!KIND_NAME[kind]) throw new CorruptError(seq, `unknown tx kind ${kind}`);
  const amount = Number(buf.readBigUInt64LE(o)); o += 8;
  const tLen = buf.readUInt8(o); o += 1;
  if (o + tLen > end) throw new CorruptError(seq, 'tx record overruns block payload');
  const target = tLen ? buf.toString('utf8', o, o + tLen) : null; o += tLen;
  return { tx: { txid, kind, amount, target }, next: o };
}

// buf must start exactly at the block start; offset is its absolute file offset.
export function decodeBlock(buf, { offset = 0, expectedSeq, expectedPrevCrc }) {
  const seq = expectedSeq;
  if (buf.length < MIN_BLOCK_LEN) {
    throw new CorruptError(seq, `truncated block: ${buf.length} byte(s) remain`);
  }
  if (!buf.subarray(0, 4).equals(BLOCK_MAGIC)) {
    throw new CorruptError(seq, 'bad block magic');
  }
  const length = buf.readUInt32LE(4);
  if (length < MIN_BLOCK_LEN || length > buf.length) {
    throw new CorruptError(seq, `invalid block length ${length}`);
  }
  const block = buf.subarray(0, length);
  if (block.readUInt32LE(8) !== seq) {
    throw new CorruptError(seq, `block sequence mismatch (found ${block.readUInt32LE(8)})`);
  }
  if (Number(block.readBigUInt64LE(12)) !== offset) {
    throw new CorruptError(seq, 'startOffset mismatch');
  }
  if (Number(block.readBigUInt64LE(20)) !== offset + length) {
    throw new CorruptError(seq, 'endOffset mismatch');
  }
  const storedCrc = block.readUInt32LE(length - CRC_LEN);
  const computed = crc32(block.subarray(0, length - CRC_LEN));
  if (storedCrc !== computed) {
    throw new CorruptError(seq, 'CRC32 mismatch');
  }
  if (block.readUInt32LE(28) !== expectedPrevCrc >>> 0) {
    throw new CorruptError(seq, 'previous-block checksum mismatch');
  }
  const txCount = block.readUInt32LE(32);
  const txs = [];
  let o = HEADER_LEN;
  const end = length - CRC_LEN;
  for (let i = 0; i < txCount; i++) {
    const r = decodeTx(block, o, end, seq);
    txs.push(r.tx);
    o = r.next;
  }
  if (o !== end) throw new CorruptError(seq, 'tx payload does not fill block');
  return { seq, startOffset: offset, endOffset: offset + length, prevCrc: expectedPrevCrc >>> 0, crc: storedCrc, length, txs };
}

export function encodeIndex(entries) {
  const buf = Buffer.alloc(INDEX_HEADER_LEN + entries.length * INDEX_ENTRY_LEN);
  INDEX_MAGIC.copy(buf, 0);
  buf.writeUInt32LE(entries.length, 4);
  entries.forEach((e, i) => {
    const o = INDEX_HEADER_LEN + i * INDEX_ENTRY_LEN;
    buf.writeUInt32LE(e.seq, o);
    buf.writeBigUInt64LE(BigInt(e.offset), o + 4);
    buf.writeUInt32LE(e.length, o + 12);
    buf.writeUInt32LE(e.crc >>> 0, o + 16);
  });
  return buf;
}

export function decodeIndex(buf) {
  if (buf.length < INDEX_HEADER_LEN || !buf.subarray(0, 4).equals(INDEX_MAGIC)) {
    throw new CorruptError(null, 'bad index magic');
  }
  const count = buf.readUInt32LE(4);
  if (buf.length !== INDEX_HEADER_LEN + count * INDEX_ENTRY_LEN) {
    throw new CorruptError(null, 'index length mismatch');
  }
  const entries = [];
  for (let i = 0; i < count; i++) {
    const o = INDEX_HEADER_LEN + i * INDEX_ENTRY_LEN;
    entries.push({
      seq: buf.readUInt32LE(o),
      offset: Number(buf.readBigUInt64LE(o + 4)),
      length: buf.readUInt32LE(o + 12),
      crc: buf.readUInt32LE(o + 16),
    });
  }
  return entries;
}
