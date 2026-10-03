import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { LedgerError, E_WAL, E_IO } from './errors.js';

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

function checksum(record) {
  const { sum, ...rest } = record;
  return createHash('sha256').update(stableStringify(rest)).digest('hex');
}

/**
 * Append-only write-ahead log. One JSON record per line, each carrying a
 * monotonically increasing `seq` and a sha256 `sum` over the record.
 * A torn tail (crash mid-append) is truncated on open; corruption anywhere
 * else is E_WAL.
 */
export class Wal {
  constructor(path) {
    this.path = path;
    this.fd = null;
    this.seq = 0;
  }

  open() {
    let data;
    try {
      data = fs.existsSync(this.path) ? fs.readFileSync(this.path, 'utf8') : '';
    } catch (err) {
      throw new LedgerError(E_IO, `cannot read WAL ${this.path}: ${err.message}`, { cause: err });
    }
    const records = [];
    let start = 0;
    let goodBytes = 0;
    while (start < data.length) {
      const nl = data.indexOf('\n', start);
      if (nl === -1) break; // torn tail: partial line without newline
      const line = data.slice(start, nl);
      const lineStart = start;
      start = nl + 1;
      if (line.length === 0) {
        throw new LedgerError(E_WAL, `empty WAL record at byte ${lineStart}`);
      }
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        throw new LedgerError(E_WAL, `corrupt WAL record at byte ${lineStart}`);
      }
      if (rec.seq !== records.length + 1) {
        throw new LedgerError(E_WAL, `WAL sequence gap: expected ${records.length + 1}, got ${rec.seq}`);
      }
      if (rec.sum !== checksum(rec)) {
        throw new LedgerError(E_WAL, `WAL checksum mismatch at seq ${rec.seq}`);
      }
      records.push(rec);
      goodBytes = start;
    }
    if (goodBytes < data.length) {
      try {
        const fd = fs.openSync(this.path, 'r+');
        try {
          fs.ftruncateSync(fd, goodBytes);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
      } catch (err) {
        throw new LedgerError(E_IO, `cannot truncate torn WAL tail: ${err.message}`, { cause: err });
      }
    }
    this.seq = records.length;
    try {
      this.fd = fs.openSync(this.path, 'a');
    } catch (err) {
      throw new LedgerError(E_IO, `cannot open WAL ${this.path}: ${err.message}`, { cause: err });
    }
    return records;
  }

  append(record) {
    // JSON round-trip drops undefined fields so the checksummed object is
    // exactly what gets persisted and later replayed.
    const full = JSON.parse(JSON.stringify({ ...record, seq: this.seq + 1 }));
    full.sum = checksum(full);
    try {
      fs.writeSync(this.fd, JSON.stringify(full) + '\n');
      fs.fsyncSync(this.fd);
    } catch (err) {
      throw new LedgerError(E_WAL, `WAL append failed at seq ${full.seq}: ${err.message}`, { cause: err });
    }
    this.seq = full.seq;
    return full;
  }

  close() {
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        /* already closed */
      }
      this.fd = null;
    }
  }
}
