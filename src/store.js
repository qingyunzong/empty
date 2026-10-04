import fs from 'node:fs';
import path from 'node:path';

export class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.journalPath = path.join(dir, 'journal.jsonl');
  }

  appendEvent(record) {
    const fd = fs.openSync(this.journalPath, 'a');
    try {
      fs.writeSync(fd, JSON.stringify(record) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  writeBatch(snapshot) {
    const name = `batch-${String(snapshot.batchSeq).padStart(6, '0')}.json`;
    const finalPath = path.join(this.dir, name);
    const tmpPath = finalPath + '.tmp';
    const data = JSON.stringify(snapshot, null, 2);
    if (process.env.CLEARING_TEST_CRASH_DURING_BATCH_WRITE) {
      const fd = fs.openSync(tmpPath, 'w');
      fs.writeSync(fd, data.slice(0, Math.floor(data.length / 2)));
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      process.kill(process.pid, 'SIGKILL');
    }
    const fd = fs.openSync(tmpPath, 'w');
    try {
      fs.writeSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, finalPath);
    const dirFd = fs.openSync(this.dir, 'r');
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  }

  recover() {
    let snapshot = null;
    let bestSeq = -1;
    for (const file of fs.readdirSync(this.dir)) {
      if (!/^batch-\d+\.json$/.test(file)) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(this.dir, file), 'utf8'));
        if (parsed.batchSeq > bestSeq) {
          bestSeq = parsed.batchSeq;
          snapshot = parsed;
        }
      } catch {
        // ignore unreadable batch file; an earlier complete one still applies
      }
    }
    const events = [];
    if (fs.existsSync(this.journalPath)) {
      const lines = fs.readFileSync(this.journalPath, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line === '') continue;
        try {
          events.push(JSON.parse(line));
        } catch (err) {
          const isTail = lines.slice(i + 1).every((l) => l === '');
          if (isTail) break; // tolerate a truncated final line from a crash
          throw new Error(`corrupt journal at line ${i + 1}: ${err.message}`);
        }
      }
    }
    return { snapshot, events };
  }
}
