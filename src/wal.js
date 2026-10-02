import fs from 'node:fs';
import crypto from 'node:crypto';

const GENESIS = '0'.repeat(64);

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export class Wal {
  constructor(path) {
    this.path = path;
    this.entries = [];
    this.hash = GENESIS;
  }

  static open(path, { replay = false } = {}) {
    const wal = new Wal(path);
    if (path && fs.existsSync(path)) {
      if (replay) {
        const lines = fs.readFileSync(path, 'utf8').split('\n').filter(Boolean);
        for (const line of lines) {
          const entry = JSON.parse(line);
          wal.entries.push(entry);
          wal.hash = sha256(wal.hash + '\n' + line);
        }
      } else {
        fs.truncateSync(path, 0);
      }
    }
    return wal;
  }

  append(entry) {
    const stored = { lsn: this.entries.length + 1, ...entry };
    const line = JSON.stringify(stored);
    this.hash = sha256(this.hash + '\n' + line);
    this.entries.push(stored);
    if (this.path) fs.appendFileSync(this.path, line + '\n');
    return stored;
  }
}
