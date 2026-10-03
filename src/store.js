import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { crc32 } from './crc32.js';

const MAGIC = Buffer.from('THR1');
const HEADER = 12; // magic(4) + length(4) + crc32(4)

export function canonical(rev) {
  return JSON.stringify({
    tradeId: rev.tradeId,
    op: rev.op,
    parents: [...rev.parents].sort(),
    author: rev.author,
    seq: rev.seq,
    changes: rev.changes ?? null,
    winner: rev.winner ?? null,
  });
}

export function hashRevision(rev) {
  return crypto.createHash('sha256').update(canonical(rev)).digest('hex').slice(0, 32);
}

export function encodeRecord(rev) {
  const payload = Buffer.from(JSON.stringify(rev), 'utf8');
  const head = Buffer.alloc(HEADER);
  MAGIC.copy(head, 0);
  head.writeUInt32BE(payload.length, 4);
  head.writeUInt32BE(crc32(payload), 8);
  return Buffer.concat([head, payload]);
}

export function decodeRecords(buf) {
  const records = [];
  let off = 0;
  while (off < buf.length) {
    if (off + HEADER > buf.length) return { records, error: { offset: off, message: 'truncated header' } };
    if (!buf.subarray(off, off + 4).equals(MAGIC)) return { records, error: { offset: off, message: 'bad magic' } };
    const len = buf.readUInt32BE(off + 4);
    const crc = buf.readUInt32BE(off + 8);
    if (off + HEADER + len > buf.length) return { records, error: { offset: off, message: 'truncated payload' } };
    const payload = buf.subarray(off + HEADER, off + HEADER + len);
    if (crc32(payload) !== crc) return { records, error: { offset: off, message: 'crc32 mismatch' } };
    let rev;
    try {
      rev = JSON.parse(payload.toString('utf8'));
    } catch {
      return { records, error: { offset: off, message: 'invalid json payload' } };
    }
    if (hashRevision(rev) !== rev.hash) return { records, error: { offset: off, message: 'hash mismatch' } };
    records.push({ offset: off, rev });
    off += HEADER + len;
  }
  return { records, error: null };
}

function buildIndex(records) {
  const offsets = {};
  const childOf = new Set();
  const authors = {};
  const trades = new Set();
  for (const { offset, rev } of records) {
    offsets[rev.hash] = offset;
    trades.add(rev.tradeId);
    for (const p of rev.parents) childOf.add(p);
    if (!(rev.author in authors) || rev.seq > authors[rev.author]) authors[rev.author] = rev.seq;
  }
  const heads = {};
  for (const tradeId of trades) {
    heads[tradeId] = records
      .filter((r) => r.rev.tradeId === tradeId && !childOf.has(r.rev.hash))
      .map((r) => r.rev.hash)
      .sort();
  }
  return { offsets, heads, authors };
}

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.dataFile = path.join(dir, 'data.blk');
    this.indexFile = path.join(dir, 'index.json');
    fs.mkdirSync(dir, { recursive: true });
  }

  readAll() {
    if (!fs.existsSync(this.dataFile)) return { records: [], error: null };
    return decodeRecords(fs.readFileSync(this.dataFile));
  }

  loadIndex() {
    try {
      return JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
    } catch {
      return null;
    }
  }

  saveIndex(index) {
    fs.writeFileSync(this.indexFile, JSON.stringify(index, null, 2));
  }

  appendRecord(rev) {
    const offset = fs.existsSync(this.dataFile) ? fs.statSync(this.dataFile).size : 0;
    fs.appendFileSync(this.dataFile, encodeRecord(rev));
    const { records, error } = this.readAll();
    if (error) throw new Error(`store corrupt after append at offset ${error.offset}: ${error.message}`);
    this.saveIndex(buildIndex(records));
    return { hash: rev.hash, offset };
  }

  getHeads(tradeId) {
    const index = this.loadIndex();
    if (!index) {
      const { records, error } = this.readAll();
      if (error) throw new Error(`data file corrupt at offset ${error.offset}: ${error.message}`);
      return buildIndex(records).heads[tradeId] ?? [];
    }
    return index.heads[tradeId] ?? [];
  }

  verify({ rebuild = false } = {}) {
    const { records, error } = this.readAll();
    if (error) return { ok: false, code: 'DATA_CORRUPT', offset: error.offset, message: error.message };

    const rebuilt = buildIndex(records);
    const byHash = new Map(records.map((r) => [r.rev.hash, r.rev]));

    // Walk the reverse chain from every head; report the first missing version.
    const allHeads = Object.values(rebuilt.heads).flat().sort();
    const visited = new Set();
    const queue = [...allHeads];
    while (queue.length) {
      const hash = queue.shift();
      if (visited.has(hash)) continue;
      visited.add(hash);
      const rev = byHash.get(hash);
      if (!rev) return { ok: false, code: 'BROKEN_CHAIN', missing: hash };
      queue.push(...rev.parents);
    }

    const index = this.loadIndex();
    const indexMatches =
      index &&
      JSON.stringify(index.offsets) === JSON.stringify(rebuilt.offsets) &&
      JSON.stringify(index.heads) === JSON.stringify(rebuilt.heads);

    if (!rebuild) {
      if (!index) return { ok: false, code: 'INDEX_MISSING', hint: 'run verify --rebuild' };
      if (!indexMatches) return { ok: false, code: 'INDEX_CORRUPT', hint: 'run verify --rebuild' };
      return { ok: true, rebuilt: false, records: records.length, heads: rebuilt.heads };
    }
    this.saveIndex(rebuilt);
    return { ok: true, rebuilt: true, records: records.length, heads: rebuilt.heads, wasCorrupt: !indexMatches };
  }
}
