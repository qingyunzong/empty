import fs from 'node:fs';
import path from 'node:path';
import { crc32 } from './crc32.js';
import { CncError, E } from './errors.js';

export const RECORD_MAGIC = Buffer.from('CNCB');
export const INDEX_MAGIC = 'CNCPKG';
const HEADER_LEN = 16; // magic(4) seq(4) len(4) crc(4)

export function buildRecord(seq, payload) {
  const body = Buffer.from(payload, 'utf8');
  const header = Buffer.alloc(HEADER_LEN);
  RECORD_MAGIC.copy(header, 0);
  header.writeUInt32LE(seq, 4);
  header.writeUInt32LE(body.length, 8);
  header.writeUInt32LE(crc32(body), 12);
  return Buffer.concat([header, body]);
}

function writeTmpRename(tmpPath, finalPath, data) {
  const fd = fs.openSync(tmpPath, 'w');
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, finalPath);
}

export function encodePackage(source, base, { blockLines = 4, name } = {}) {
  const lines = source.split(/\r?\n/);
  const parts = [];
  const entries = [];
  let offset = 0;
  for (let i = 0, seq = 0; i < lines.length; i += blockLines, seq++) {
    const payload = lines.slice(i, i + blockLines).join('\n');
    const record = buildRecord(seq, payload);
    entries.push({
      seq,
      offset,
      length: record.length,
      crc: crc32(payload).toString(16).padStart(8, '0'),
    });
    offset += record.length;
    parts.push(record);
  }
  writeTmpRename(`${base}.blk.tmp`, `${base}.blk`, Buffer.concat(parts));
  const index = {
    magic: INDEX_MAGIC,
    version: 1,
    programName: name ?? path.basename(base),
    blockLines,
    blockCount: entries.length,
    range: entries.length ? { first: entries[0].seq, last: entries[entries.length - 1].seq } : null,
    entry: entries.length ? { seq: entries[0].seq, offset: entries[0].offset } : null,
    blocks: entries,
  };
  writeTmpRename(`${base}.idx.tmp`, `${base}.idx`, JSON.stringify(index, null, 2));
  return index;
}

export function readIndex(base) {
  const index = JSON.parse(fs.readFileSync(`${base}.idx`, 'utf8'));
  if (index.magic !== INDEX_MAGIC) throw new CncError(E.FORMAT, 'bad index magic');
  return index;
}

function readRecordAt(fd, entry) {
  const header = Buffer.alloc(HEADER_LEN);
  const got = fs.readSync(fd, header, 0, HEADER_LEN, entry.offset);
  if (got < HEADER_LEN || !header.subarray(0, 4).equals(RECORD_MAGIC)) {
    throw new CncError(E.FORMAT, `block ${entry.seq}: bad record header`);
  }
  const seq = header.readUInt32LE(4);
  const len = header.readUInt32LE(8);
  const crc = header.readUInt32LE(12);
  if (seq !== entry.seq) throw new CncError(E.FORMAT, `block ${entry.seq}: sequence mismatch`);
  if (len !== entry.length - HEADER_LEN) throw new CncError(E.FORMAT, `block ${seq}: length mismatch`);
  const body = Buffer.alloc(len);
  if (fs.readSync(fd, body, 0, len, entry.offset + HEADER_LEN) < len) {
    throw new CncError(E.FORMAT, `block ${seq}: truncated payload`);
  }
  return { seq, payload: body.toString('utf8'), crc };
}

export function readAllRecords(base, index = readIndex(base)) {
  const fd = fs.openSync(`${base}.blk`, 'r');
  try {
    return index.blocks.map((entry) => readRecordAt(fd, entry));
  } finally {
    fs.closeSync(fd);
  }
}

export function verifyPackage(base) {
  const index = readIndex(base);
  const records = readAllRecords(base, index);
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    const entry = index.blocks[i];
    if (rec.crc !== Number.parseInt(entry.crc, 16)) {
      throw new CncError(E.CRC, `block ${rec.seq}: index/record crc mismatch`);
    }
    if (crc32(rec.payload) !== rec.crc) {
      throw new CncError(E.CRC, `block ${rec.seq}: payload crc mismatch`);
    }
  }
  const warnings = [];
  const size = fs.statSync(`${base}.blk`).size;
  const indexedEnd = index.blocks.length
    ? Math.max(...index.blocks.map((b) => b.offset + b.length))
    : 0;
  if (size > indexedEnd) warnings.push(`unindexed tail: ${size - indexedEnd} byte(s) ignored`);
  return { ok: true, blocks: records.length, warnings };
}
