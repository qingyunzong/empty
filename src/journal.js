// Append-only journal. Each line is one JSON record. Appends are followed by
// fsync so a crash can lose at most the un-flushed tail; recovery replays
// complete lines and ignores a torn final line.

import fs from 'node:fs';
import path from 'node:path';

export class Journal {
  constructor(file) {
    this.file = file;
    this.fd = null;
  }

  open() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.fd = fs.openSync(this.file, 'a');
    return this;
  }

  append(record) {
    const line = JSON.stringify(record) + '\n';
    fs.writeSync(this.fd, line);
    fs.fsyncSync(this.fd);
  }

  close() {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }

  // Replay all complete records; a torn trailing line (crash mid-append) is
  // dropped rather than aborting recovery.
  static replay(file) {
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, 'utf8');
    const records = [];
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        // torn tail from a crash during append: ignore
      }
    }
    return records;
  }
}
