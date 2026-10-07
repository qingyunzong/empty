import fs from 'node:fs';
import path from 'node:path';
import { Aggregator } from './windows.js';

export class CrashInjected extends Error {
  constructor(point) {
    super(`fault injected: crash ${point}`);
    this.name = 'CrashInjected';
    this.point = point;
  }
}

// Crash-safe event store.
//
// Durability protocol per batch:
//   1. append the batch to the append-only log (events.log) + fsync
//   2. apply the batch to the in-memory index and persist index.json
//      ({offset, events}) atomically via tmp file + rename
//
// Fixed crash points:
//   - crash before append  -> the batch has zero effect (nothing in the log)
//   - crash after append, before index -> the batch is in the log but not in
//     the index; on restart open() replays the log lines beyond the indexed
//     offset, so the batch is applied exactly once.
export class Store {
  constructor(dir) {
    this.dir = dir;
    this.logPath = path.join(dir, 'events.log');
    this.indexPath = path.join(dir, 'index.json');
    this.aggregator = new Aggregator();
    this.events = [];
    this.offset = 0;
  }

  static open(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const store = new Store(dir);
    let indexed = { offset: 0, events: [] };
    if (fs.existsSync(store.indexPath)) {
      indexed = JSON.parse(fs.readFileSync(store.indexPath, 'utf8'));
    }
    for (const event of indexed.events) store.apply(event);
    const lines = store.readLogLines();
    for (let i = indexed.offset; i < lines.length; i += 1) {
      store.apply(JSON.parse(lines[i])); // replay unindexed tail of the log
    }
    store.offset = lines.length;
    if (lines.length !== indexed.offset) store.persistIndex();
    return store;
  }

  apply(event) {
    if (this.aggregator.insert(event).inserted) this.events.push(event);
  }

  readLogLines() {
    if (!fs.existsSync(this.logPath)) return [];
    return fs.readFileSync(this.logPath, 'utf8').split('\n').filter(Boolean);
  }

  persistIndex() {
    const tmp = `${this.indexPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ offset: this.offset, events: this.events }));
    fs.renameSync(tmp, this.indexPath);
  }

  appendBatch(events, { crash } = {}) {
    if (crash === 'before-append') throw new CrashInjected('before-append');
    const fd = fs.openSync(this.logPath, 'a');
    try {
      fs.writeSync(fd, `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (crash === 'after-append') throw new CrashInjected('after-append');
    for (const event of events) this.apply(event);
    this.offset = this.readLogLines().length;
    this.persistIndex();
    return events.length;
  }

  query(device, from, to) {
    return this.aggregator.query(device, from, to);
  }

  // Fold the whole log into the snapshot index and truncate the log.
  compact() {
    this.offset = 0;
    this.persistIndex();
    const fd = fs.openSync(this.logPath, 'w');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return { events: this.events.length };
  }
}
