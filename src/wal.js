import fs from 'node:fs';

// Append-only write-ahead log. One JSON record per line.
// A transaction is durable iff its `commit` record has been written and fsynced.
// Torn/partial tail lines (crash mid-write) are tolerated on replay.
export class Wal {
  constructor(file) {
    this.file = file;
    this.fd = fs.openSync(file, 'a+');
  }

  append(record) {
    fs.writeSync(this.fd, JSON.stringify(record) + '\n');
  }

  sync() {
    fs.fsyncSync(this.fd);
  }

  *read() {
    let buf;
    try {
      buf = fs.readFileSync(this.file, 'utf8');
    } catch {
      return;
    }
    const lines = buf.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      try {
        yield JSON.parse(line);
      } catch {
        // Torn tail from a crash: only acceptable on the very last line.
        if (i !== lines.length - 1 && lines.slice(i).some((l) => l.trim())) {
          throw new Error(`WAL corrupted at line ${i + 1}`);
        }
        return;
      }
    }
  }

  close() {
    fs.closeSync(this.fd);
  }
}
