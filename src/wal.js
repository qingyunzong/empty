import fs from 'node:fs';
import zlib from 'node:zlib';
import { StoreError } from './errors.js';

const checksum = (s) => zlib.crc32(Buffer.from(s, 'utf8')).toString(16).padStart(8, '0');

export function encodeEntry(entry) {
  const json = JSON.stringify(entry);
  return `${checksum(json)} ${json}\n`;
}

// Reads the WAL and returns every fully-written, checksum-valid entry plus the
// byte offset just past the last commit marker. A torn tail (final line not
// terminated by '\n') is dropped silently; any other malformed line is
// corruption.
export function scanWal(file) {
  const buf = fs.readFileSync(file);
  const text = buf.toString('utf8');
  const lines = text.split('\n');
  const entries = [];
  let offset = 0;
  let committedBytes = 0;
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i];
    const sp = line.indexOf(' ');
    if (sp <= 0) throw new StoreError('E_CORRUPT', `wal line ${i + 1}: missing checksum`);
    const json = line.slice(sp + 1);
    if (line.slice(0, sp) !== checksum(json)) {
      throw new StoreError('E_CORRUPT', `wal line ${i + 1}: checksum mismatch`);
    }
    let entry;
    try {
      entry = JSON.parse(json);
    } catch {
      throw new StoreError('E_CORRUPT', `wal line ${i + 1}: invalid json`);
    }
    if (typeof entry !== 'object' || entry === null || typeof entry.t !== 'string') {
      throw new StoreError('E_CORRUPT', `wal line ${i + 1}: malformed entry`);
    }
    entries.push(entry);
    offset += Buffer.byteLength(line, 'utf8') + 1;
    if (entry.t === 'commit') committedBytes = offset;
  }
  return { entries, committedBytes, totalBytes: buf.length };
}

export class WalWriter {
  constructor(file) {
    this.fd = fs.openSync(file, 'a');
  }
  append(entry) {
    fs.writeSync(this.fd, encodeEntry(entry));
  }
  sync() {
    fs.fsyncSync(this.fd);
  }
  close() {
    fs.closeSync(this.fd);
  }
}
