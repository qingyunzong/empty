import fs from 'node:fs';
import { CorruptionError, InjectedCrash } from './errors.js';

// WAL entry layout (JSON Lines):
//   {"k":"d","seq":N,"record":{...},"hash":"..."}   data line, fsync'ed  -> crash point "after-data-sync"
//   {"k":"c","seq":N,"hash":"..."}                  commit marker, fsync'ed -> crash point "after-commit-sync"
// A data line counts as committed only when immediately followed by its
// matching commit marker. Anything after the last commit marker is a stale
// tail from a crashed write and is truncated on recovery.
export class Wal {
  constructor(file) {
    this.file = file;
  }

  appendCommitted(record, hash, fault) {
    const dataLine = `${JSON.stringify({ k: 'd', seq: record.seq, record, hash })}\n`;
    const commitLine = `${JSON.stringify({ k: 'c', seq: record.seq, hash })}\n`;
    const fd = fs.openSync(this.file, 'a');
    try {
      fs.writeSync(fd, dataLine);
      fs.fsyncSync(fd);
      if (fault === 'after-data-sync') throw new InjectedCrash('after-data-sync');
      fs.writeSync(fd, commitLine);
      fs.fsyncSync(fd);
      if (fault === 'after-commit-sync') throw new InjectedCrash('after-commit-sync');
    } finally {
      fs.closeSync(fd);
    }
  }

  scan() {
    if (!fs.existsSync(this.file)) {
      return { committed: [], discarded: 0, committedBytes: 0 };
    }
    const text = fs.readFileSync(this.file, 'utf8');
    const lines = text.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    const offsets = [];
    let offset = 0;
    for (const line of lines) {
      offsets.push(offset);
      offset += Buffer.byteLength(line, 'utf8') + 1;
    }
    const committed = [];
    let discarded = 0;
    let committedBytes = 0;
    let i = 0;
    while (i < lines.length) {
      let entry;
      try {
        entry = JSON.parse(lines[i]);
      } catch {
        if (i === lines.length - 1) {
          discarded += 1; // torn tail from a crashed write
          break;
        }
        throw new CorruptionError(`WAL line ${i + 1} is not valid JSON`);
      }
      if (entry && entry.k === 'd') {
        let commit = null;
        if (i + 1 < lines.length) {
          try {
            commit = JSON.parse(lines[i + 1]);
          } catch {
            commit = null;
          }
        }
        if (commit && commit.k === 'c' && commit.seq === entry.seq && commit.hash === entry.hash) {
          committed.push(entry);
          committedBytes = offsets[i + 1] + Buffer.byteLength(lines[i + 1], 'utf8') + 1;
          i += 2;
          continue;
        }
        discarded += 1; // data synced but commit marker never written
        i += 1;
        continue;
      }
      throw new CorruptionError(`WAL line ${i + 1}: unexpected entry (orphan commit marker or unknown kind)`);
    }
    return { committed, discarded, committedBytes };
  }

  truncateTo(byteLength) {
    if (!fs.existsSync(this.file)) return;
    if (fs.statSync(this.file).size > byteLength) {
      fs.truncateSync(this.file, byteLength);
    }
  }
}
