import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { crc32 } from './crc32.js';

export const MAGIC = Buffer.from('FZLK');
export const VERSION = 1;
export const HEADER_LEN = 60;
export const ZERO_HASH = '0'.repeat(64);

const CHUNK_RE = /^chunk-(\d{6,})\.chk$/;

export function chunksDir(dir) {
  return path.join(dir, 'chunks');
}

export function chunkFileName(ordinal) {
  return `chunk-${String(ordinal).padStart(6, '0')}.chk`;
}

export function encodeChunk({ seqStart, seqEnd, prevHash, events }) {
  const payload = Buffer.from(JSON.stringify(events), 'utf8');
  const compressed = deflateRawSync(payload);
  const header = Buffer.alloc(HEADER_LEN);
  MAGIC.copy(header, 0);
  header.writeUInt32LE(VERSION, 4);
  header.writeUInt32LE(seqStart, 8);
  header.writeUInt32LE(seqEnd, 12);
  Buffer.from(prevHash, 'hex').copy(header, 16);
  header.writeUInt32LE(compressed.length, 48);
  header.writeUInt32LE(payload.length, 52);
  const crc = crc32(Buffer.concat([header.subarray(0, 56), compressed]));
  header.writeUInt32LE(crc, 56);
  return Buffer.concat([header, compressed]);
}

export function decodeChunk(buf) {
  if (buf.length < HEADER_LEN) throw new Error(`truncated header (${buf.length} < ${HEADER_LEN} bytes)`);
  if (!buf.subarray(0, 4).equals(MAGIC)) throw new Error('bad magic');
  const version = buf.readUInt32LE(4);
  if (version !== VERSION) throw new Error(`unsupported version ${version}`);
  const seqStart = buf.readUInt32LE(8);
  const seqEnd = buf.readUInt32LE(12);
  const prevHash = buf.subarray(16, 48).toString('hex');
  const compressedLen = buf.readUInt32LE(48);
  const uncompressedLen = buf.readUInt32LE(52);
  const crc = buf.readUInt32LE(56);
  if (seqEnd < seqStart || seqStart === 0) throw new Error(`invalid sequence range ${seqStart}..${seqEnd}`);
  if (buf.length !== HEADER_LEN + compressedLen) {
    throw new Error(`length mismatch: file has ${buf.length - HEADER_LEN} payload bytes, header declares ${compressedLen}`);
  }
  const compressed = buf.subarray(HEADER_LEN);
  const actual = crc32(Buffer.concat([buf.subarray(0, 56), compressed]));
  if (actual !== crc) throw new Error(`crc mismatch: stored ${crc}, computed ${actual}`);
  const payload = inflateRawSync(compressed);
  if (payload.length !== uncompressedLen) throw new Error('uncompressed length mismatch');
  const events = JSON.parse(payload.toString('utf8'));
  if (!Array.isArray(events)) throw new Error('payload is not an event array');
  return { seqStart, seqEnd, prevHash, compressedLen, uncompressedLen, events };
}

export function chunkHash(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export function listChunks(dir) {
  const cdir = chunksDir(dir);
  if (!fs.existsSync(cdir)) return [];
  return fs.readdirSync(cdir)
    .map((file) => {
      const m = CHUNK_RE.exec(file);
      return m ? { file, ordinal: Number(m[1]), path: path.join(cdir, file) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.ordinal - b.ordinal);
}

export function verifyChain(dir) {
  const files = listChunks(dir);
  const valid = [];
  let prevHash = ZERO_HASH;
  let prevEnd = 0;
  for (const f of files) {
    const buf = fs.readFileSync(f.path);
    let decoded;
    try {
      decoded = decodeChunk(buf);
    } catch (err) {
      return { ok: false, bad: { file: f.file, ordinal: f.ordinal, reason: err.message }, valid, tip: { seqEnd: prevEnd, hash: prevHash } };
    }
    if (decoded.seqStart !== prevEnd + 1) {
      return { ok: false, bad: { file: f.file, ordinal: f.ordinal, reason: `sequence gap: expected seqStart ${prevEnd + 1}, got ${decoded.seqStart}` }, valid, tip: { seqEnd: prevEnd, hash: prevHash } };
    }
    if (decoded.prevHash !== prevHash) {
      return { ok: false, bad: { file: f.file, ordinal: f.ordinal, reason: 'prev hash mismatch' }, valid, tip: { seqEnd: prevEnd, hash: prevHash } };
    }
    const hash = chunkHash(buf);
    valid.push({ file: f.file, ordinal: f.ordinal, hash, ...decoded });
    prevEnd = decoded.seqEnd;
    prevHash = hash;
  }
  return { ok: true, chunks: valid, tip: { seqEnd: prevEnd, hash: prevHash } };
}

export function appendChunk(dir, tip, events, { fsync = true } = {}) {
  const cdir = chunksDir(dir);
  fs.mkdirSync(cdir, { recursive: true });
  const ordinal = listChunks(dir).length + 1;
  const seqStart = tip.seqEnd + 1;
  const seqEnd = seqStart + events.length - 1;
  const buf = encodeChunk({ seqStart, seqEnd, prevHash: tip.hash, events });
  const file = chunkFileName(ordinal);
  const filePath = path.join(cdir, file);
  const fd = fs.openSync(filePath, 'w');
  try {
    fs.writeSync(fd, buf);
    if (fsync) fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (fsync) {
    const dfd = fs.openSync(cdir, 'r');
    try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
  }
  return { file, ordinal, seqStart, seqEnd, hash: chunkHash(buf) };
}
