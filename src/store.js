// Append-only chunked revision store.
//
// Layout of a store directory:
//   <dir>/chunks/chunk-000001.bin   (data blocks, rolled over at maxChunkSize)
//   <dir>/index.idx                 (offset index page, CRC-protected)
//
// Record framing inside a chunk:
//   magic   4 bytes  'TXR1'
//   length  u32 LE   payload byte length
//   crc32   u32 LE   CRC32 of payload
//   payload JSON utf8 (the revision record)
//
// Index page format:
//   magic   4 bytes  'TXI1'
//   count   u32 LE
//   entries count x { hashLen u8, hash utf8, chunk u32 LE, offset u32 LE, length u32 LE }
//   crc32   u32 LE   over everything before it
import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { crc32 } from './crc32.js';

const RECORD_MAGIC = Buffer.from('TXR1');
const INDEX_MAGIC = Buffer.from('TXI1');
const HEADER_SIZE = 12; // magic + length + crc32

export class Store {
  constructor(dir, { maxChunkSize = 1024 * 1024 } = {}) {
    this.dir = dir;
    this.maxChunkSize = maxChunkSize;
    this.chunksDir = join(dir, 'chunks');
    this.indexPath = join(dir, 'index.idx');
    mkdirSync(this.chunksDir, { recursive: true });
  }

  _chunkFiles() {
    if (!existsSync(this.chunksDir)) return [];
    return readdirSync(this.chunksDir)
      .filter((f) => /^chunk-\d{6}\.bin$/.test(f))
      .sort();
  }

  _nextChunkId() {
    const files = this._chunkFiles();
    if (files.length === 0) return 1;
    const last = files[files.length - 1];
    return parseInt(last.slice(6, 12), 10) + 1;
  }

  _chunkPath(id) {
    return join(this.chunksDir, `chunk-${String(id).padStart(6, '0')}.bin`);
  }

  _chunkSize(id) {
    const p = this._chunkPath(id);
    return existsSync(p) ? readFileSync(p).length : 0;
  }

  // Append a record object; returns { hash, chunk, offset, length }.
  append(record) {
    const payload = Buffer.from(JSON.stringify(record), 'utf8');
    const header = Buffer.alloc(HEADER_SIZE);
    RECORD_MAGIC.copy(header, 0);
    header.writeUInt32LE(payload.length, 4);
    header.writeUInt32LE(crc32(payload), 8);
    const block = Buffer.concat([header, payload]);

    const files = this._chunkFiles();
    let chunkId = files.length === 0 ? 1 : parseInt(files[files.length - 1].slice(6, 12), 10);
    if (files.length === 0 || this._chunkSize(chunkId) + block.length > this.maxChunkSize) {
      chunkId = files.length === 0 ? 1 : this._nextChunkId();
    }
    const offset = this._chunkSize(chunkId);
    writeFileSync(this._chunkPath(chunkId), block, { flag: 'a' });
    const loc = { hash: record.hash, chunk: chunkId, offset, length: block.length };
    this._indexAppend(loc);
    return loc;
  }

  // Scan all chunks, validating framing + CRC32. Never throws on corruption;
  // stops the affected chunk at the first bad record and reports it.
  scan() {
    const records = [];
    const locations = new Map(); // hash -> {chunk, offset, length}
    const corrupt = [];
    for (const file of this._chunkFiles()) {
      const chunkId = parseInt(file.slice(6, 12), 10);
      const buf = readFileSync(join(this.chunksDir, file));
      let pos = 0;
      while (pos + HEADER_SIZE <= buf.length) {
        if (!buf.subarray(pos, pos + 4).equals(RECORD_MAGIC)) {
          corrupt.push({ chunk: chunkId, offset: pos, reason: 'BAD_MAGIC' });
          break;
        }
        const length = buf.readUInt32LE(pos + 4);
        const expectedCrc = buf.readUInt32LE(pos + 8);
        if (pos + HEADER_SIZE + length > buf.length) {
          corrupt.push({ chunk: chunkId, offset: pos, reason: 'TRUNCATED' });
          break;
        }
        const payload = buf.subarray(pos + HEADER_SIZE, pos + HEADER_SIZE + length);
        if (crc32(payload) !== expectedCrc) {
          corrupt.push({ chunk: chunkId, offset: pos, reason: 'CRC_MISMATCH' });
          break;
        }
        let record;
        try {
          record = JSON.parse(payload.toString('utf8'));
        } catch {
          corrupt.push({ chunk: chunkId, offset: pos, reason: 'BAD_JSON' });
          break;
        }
        record._loc = { chunk: chunkId, offset: pos, length: HEADER_SIZE + length };
        records.push(record);
        locations.set(record.hash, record._loc);
        pos += HEADER_SIZE + length;
      }
      if (pos < buf.length && !corrupt.some((c) => c.chunk === chunkId)) {
        corrupt.push({ chunk: chunkId, offset: pos, reason: 'TRAILING_BYTES' });
      }
    }
    return { records, locations, corrupt };
  }

  // ---- index page ----

  _indexAppend(loc) {
    const entries = [];
    const existing = this.readIndex();
    if (existing.ok) entries.push(...existing.entries);
    entries.push(loc);
    this.writeIndex(entries);
  }

  writeIndex(entries) {
    const body = [];
    const head = Buffer.alloc(8);
    INDEX_MAGIC.copy(head, 0);
    head.writeUInt32LE(entries.length, 4);
    body.push(head);
    for (const e of entries) {
      const hashBuf = Buffer.from(e.hash, 'utf8');
      const row = Buffer.alloc(1 + hashBuf.length + 12);
      row.writeUInt8(hashBuf.length, 0);
      hashBuf.copy(row, 1);
      row.writeUInt32LE(e.chunk, 1 + hashBuf.length);
      row.writeUInt32LE(e.offset, 1 + hashBuf.length + 4);
      row.writeUInt32LE(e.length, 1 + hashBuf.length + 8);
      body.push(row);
    }
    const content = Buffer.concat(body);
    const trailer = Buffer.alloc(4);
    trailer.writeUInt32LE(crc32(content), 0);
    const tmp = this.indexPath + '.tmp';
    writeFileSync(tmp, Buffer.concat([content, trailer]));
    renameSync(tmp, this.indexPath);
  }

  // Returns { ok:true, entries } or { ok:false, reason }.
  readIndex() {
    if (!existsSync(this.indexPath)) return { ok: false, reason: 'INDEX_MISSING' };
    const buf = readFileSync(this.indexPath);
    if (buf.length < 12 || !buf.subarray(0, 4).equals(INDEX_MAGIC)) {
      return { ok: false, reason: 'INDEX_CORRUPT' };
    }
    const storedCrc = buf.readUInt32LE(buf.length - 4);
    if (crc32(buf.subarray(0, buf.length - 4)) !== storedCrc) {
      return { ok: false, reason: 'INDEX_CORRUPT' };
    }
    const count = buf.readUInt32LE(4);
    const entries = [];
    let pos = 8;
    for (let i = 0; i < count; i++) {
      if (pos >= buf.length - 4) return { ok: false, reason: 'INDEX_CORRUPT' };
      const hashLen = buf.readUInt8(pos);
      const hash = buf.subarray(pos + 1, pos + 1 + hashLen).toString('utf8');
      const base = pos + 1 + hashLen;
      if (base + 12 > buf.length - 4) return { ok: false, reason: 'INDEX_CORRUPT' };
      entries.push({
        hash,
        chunk: buf.readUInt32LE(base),
        offset: buf.readUInt32LE(base + 4),
        length: buf.readUInt32LE(base + 8),
      });
      pos = base + 12;
    }
    if (pos !== buf.length - 4) return { ok: false, reason: 'INDEX_CORRUPT' };
    return { ok: true, entries };
  }

  // Verify store integrity; optionally rebuild the index page from the
  // reverse (parent) chain when the index is missing/corrupt/mismatched.
  verify({ rebuild = false } = {}) {
    const { records, locations, corrupt } = this.scan();
    const index = this.readIndex();

    let indexProblem = null;
    if (!index.ok) {
      indexProblem = index.reason;
    } else {
      const indexed = new Map(index.entries.map((e) => [e.hash, e]));
      for (const [hash, loc] of locations) {
        const e = indexed.get(hash);
        if (!e || e.chunk !== loc.chunk || e.offset !== loc.offset || e.length !== loc.length) {
          indexProblem = 'INDEX_MISMATCH';
          break;
        }
      }
      if (!indexProblem && indexed.size !== locations.size) indexProblem = 'INDEX_MISMATCH';
    }

    // Reverse-chain check: every non-genesis parent must resolve to a record.
    let firstMissing = null;
    for (const rec of records) {
      for (const parent of rec.parents || []) {
        if (!locations.has(parent)) {
          firstMissing = { hash: parent, referencedBy: rec.hash };
          break;
        }
      }
      if (firstMissing) break;
    }

    const result = {
      ok: true,
      records: records.length,
      chunks: this._chunkFiles().length,
      corruptBlocks: corrupt,
      index: index.ok ? 'OK' : indexProblem,
      chain: firstMissing ? 'BROKEN' : 'OK',
    };
    if (firstMissing) result.firstMissing = firstMissing;

    if (corrupt.length > 0 || firstMissing) {
      result.ok = false;
      result.error = firstMissing ? 'CHAIN_BROKEN' : 'BLOCK_CORRUPT';
      return result;
    }
    if (indexProblem) {
      if (!rebuild) {
        result.ok = false;
        result.error = indexProblem;
        return result;
      }
      const entries = records.map((r) => ({ hash: r.hash, ...r._loc }));
      this.writeIndex(entries);
      result.rebuilt = true;
      result.indexEntries = entries.length;
    }
    return result;
  }
}
