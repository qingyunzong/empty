import fs from 'node:fs';
import path from 'node:path';

// Crash-safe persistence: the journal is append-only with fsync; batch files
// are written to a temp file, fsynced, then atomically renamed. A kill in the
// middle of a batch write can therefore only leave a stale *.tmp file, never
// a half-written batch.
export class Store {
  constructor(dir) {
    this.dir = dir;
    this.journalPath = path.join(dir, 'journal.jsonl');
  }

  init() {
    fs.mkdirSync(this.dir, { recursive: true });
    for (const name of fs.readdirSync(this.dir)) {
      if (name.endsWith('.tmp')) fs.rmSync(path.join(this.dir, name));
    }
  }

  loadJournal() {
    if (!fs.existsSync(this.journalPath)) return { events: [], truncated: false };
    const buf = fs.readFileSync(this.journalPath);
    const events = [];
    let offset = 0;
    let truncated = false;
    while (offset < buf.length) {
      const nl = buf.indexOf(0x0a, offset);
      if (nl === -1) {
        truncated = true; // torn tail without newline
        break;
      }
      const line = buf.subarray(offset, nl).toString('utf8');
      try {
        events.push(JSON.parse(line).event);
      } catch {
        truncated = true; // torn tail with unparseable JSON
        break;
      }
      offset = nl + 1;
    }
    if (truncated) fs.truncateSync(this.journalPath, offset);
    return { events, truncated };
  }

  appendJournal(entry) {
    const fd = fs.openSync(this.journalPath, 'a');
    try {
      fs.writeSync(fd, JSON.stringify(entry) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  writeBatch(batch) {
    const tmp = path.join(this.dir, `batch-${batch.n}.json.tmp`);
    const final = path.join(this.dir, `batch-${batch.n}.json`);
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, JSON.stringify(batch, null, 2) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, final);
    const dirFd = fs.openSync(this.dir, 'r');
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  }

  listBatches() {
    return fs.readdirSync(this.dir).filter((name) => /^batch-\d+\.json$/.test(name));
  }

  removeBatch(name) {
    fs.rmSync(path.join(this.dir, name));
  }
}
