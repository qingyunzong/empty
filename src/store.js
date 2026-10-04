import fs from 'node:fs';
import path from 'node:path';
import { Engine } from './engine.js';

// events.jsonl is the source of truth (append + fsync before anything else).
// queue.json is a derived cache of the batch/task snapshot; a crash mid-write
// of queue.json is harmless because load() always replays the event log and
// only uses queue.json as a checksum-verified cache.
export class Store {
  constructor(dir) {
    this.dir = dir;
    this.eventsFile = path.join(dir, 'events.jsonl');
    this.queueFile = path.join(dir, 'queue.json');
    fs.mkdirSync(dir, { recursive: true });
    const { engine, recovered } = Store.replay(this.eventsFile, this.queueFile);
    this.engine = engine;
    this.recovered = recovered;
  }

  static replay(eventsFile, queueFile) {
    const engine = new Engine();
    if (fs.existsSync(eventsFile)) {
      for (const line of fs.readFileSync(eventsFile, 'utf8').split('\n')) {
        if (line.trim()) engine.apply(JSON.parse(line));
      }
    }
    let recovered = false;
    if (fs.existsSync(queueFile)) {
      let cacheOk = false;
      try {
        const cache = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
        cacheOk = cache && cache.proof && cache.proof.hash === engine.proof().hash;
      } catch { cacheOk = false; }
      recovered = !cacheOk; // torn/ stale queue write detected; replay won
    }
    return { engine, recovered };
  }

  apply(op) {
    const result = this.engine.apply(op);
    const fd = fs.openSync(this.eventsFile, 'a');
    try {
      fs.writeSync(fd, JSON.stringify(op) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.writeQueue();
    return result;
  }

  writeQueue() {
    const snapshot = {
      proof: this.engine.proof(),
      batches: [...this.engine.batches.values()].map((b) => ({ ...b, taskIds: [...b.taskIds] })),
    };
    fs.writeFileSync(this.queueFile, JSON.stringify(snapshot));
  }
}
