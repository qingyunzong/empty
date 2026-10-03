// Durability layer: atomic JSON snapshot + append-only WAL (JSON lines).
import fs from 'node:fs';
import path from 'node:path';

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.storeFile = path.join(dir, 'store.json');
    this.walFile = path.join(dir, 'wal.log');
  }

  ensure() {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  loadState() {
    if (!fs.existsSync(this.storeFile)) return null;
    return JSON.parse(fs.readFileSync(this.storeFile, 'utf8'));
  }

  // Write tmp file, fsync, then rename for atomic replacement.
  saveState(state) {
    this.ensure();
    const tmp = `${this.storeFile}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, JSON.stringify(state, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.storeFile);
  }

  appendWal(record) {
    this.ensure();
    const fd = fs.openSync(this.walFile, 'a');
    try {
      fs.writeSync(fd, `${JSON.stringify(record)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return record;
  }

  readWal() {
    if (!fs.existsSync(this.walFile)) return [];
    return fs
      .readFileSync(this.walFile, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
  }
}
