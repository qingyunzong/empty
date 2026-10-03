import fs from 'node:fs';
import { stableStringify, sha256 } from './canon.js';
import { CorruptionError } from './errors.js';

function checksum(rec) {
  return sha256(stableStringify(rec));
}

export class Wal {
  constructor(path) {
    this.path = path;
    this.fd = fs.openSync(path, 'a');
  }
  append(rec) {
    const line = JSON.stringify({ ...rec, sum: checksum(rec) }) + '\n';
    fs.writeSync(this.fd, line);
  }
  fsync() { fs.fsyncSync(this.fd); }
  truncate() { fs.ftruncateSync(this.fd, 0); }
  close() { try { fs.closeSync(this.fd); } catch { /* already closed */ } }
}

export function readWal(path) {
  if (!fs.existsSync(path)) return { records: [], tornOffset: null };
  const buf = fs.readFileSync(path);
  const records = [];
  let offset = 0;
  let tornOffset = null;
  while (offset < buf.length) {
    const nl = buf.indexOf(0x0a, offset);
    const end = nl === -1 ? buf.length : nl;
    const line = buf.subarray(offset, end).toString('utf8');
    if (line.trim().length === 0 && nl === -1) { tornOffset = offset; break; }
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      if (nl === -1) { tornOffset = offset; break; }
      throw new CorruptionError(`wal: unparseable record at offset ${offset}`);
    }
    const { sum, ...rec } = parsed;
    if (typeof sum !== 'string' || sum !== checksum(rec)) {
      if (nl === -1) { tornOffset = offset; break; }
      throw new CorruptionError(`wal: checksum mismatch at offset ${offset}`);
    }
    records.push(rec);
    if (nl === -1) break;
    offset = nl + 1;
  }
  return { records, tornOffset };
}
