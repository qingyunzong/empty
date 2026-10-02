import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { canonical } from './canon.js';

export const GENESIS = '0'.repeat(64);

function entryHash(prev, seq, type, data) {
  return createHash('sha256').update([prev, seq, type, canonical(data)].join('|')).digest('hex');
}

export class EventLog {
  constructor(entries = [], path = null) {
    this.entries = entries;
    this.path = path;
  }

  get root() {
    const n = this.entries.length;
    return n ? this.entries[n - 1].hash : GENESIS;
  }

  get length() {
    return this.entries.length;
  }

  append(type, data) {
    const seq = this.entries.length;
    const prev = this.root;
    const hash = entryHash(prev, seq, type, data);
    const entry = { seq, type, data, prev, hash };
    this.entries.push(entry);
    if (this.path) appendFileSync(this.path, JSON.stringify(entry) + '\n');
    return entry;
  }

  static recover(text, path = null) {
    const entries = [];
    let discarded = 0;
    let validBytes = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let e = null;
      try {
        e = JSON.parse(line);
      } catch {
        e = null;
      }
      const prev = entries.length ? entries[entries.length - 1].hash : GENESIS;
      const ok =
        e !== null &&
        e.seq === entries.length &&
        e.prev === prev &&
        e.hash === entryHash(e.prev, e.seq, e.type, e.data);
      if (!ok) {
        discarded += 1;
        break;
      }
      entries.push(e);
      validBytes += Buffer.byteLength(line) + 1;
    }
    return { log: new EventLog(entries, path), discarded, validBytes };
  }
}

// Read a log file, keep only the valid hash-chain prefix, and repair the
// file on disk so later appends never concatenate onto a torn line.
export function recoverLogFile(path) {
  const text = readFileSync(path, 'utf8');
  const { log, discarded, validBytes } = EventLog.recover(text, path);
  const total = Buffer.byteLength(text);
  if (discarded > 0 || validBytes < total) {
    const prefix = log.entries.map((e) => JSON.stringify(e)).join('\n');
    writeFileSync(path, prefix.length ? prefix + '\n' : '');
  }
  return log;
}
