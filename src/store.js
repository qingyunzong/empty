'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Engine, stable, sha } = require('./engine');

class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.journalFile = path.join(dir, 'journal.jsonl');
    this.indexFile = path.join(dir, 'index.json');
  }

  load() {
    const events = [];
    if (fs.existsSync(this.journalFile)) {
      for (const line of fs.readFileSync(this.journalFile, 'utf8').split('\n')) {
        const s = line.trim();
        if (s) events.push(JSON.parse(s));
      }
    }
    let index = null;
    let indexValid = false;
    const indexExists = fs.existsSync(this.indexFile);
    if (indexExists) {
      try {
        const idx = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
        if (idx && idx.checksum === sha(stable({ journalSeq: idx.journalSeq, queues: idx.queues }))) {
          index = idx;
          indexValid = true;
        }
      } catch {
        // torn or corrupt index write: treated as crash mid index update
      }
    }
    return { events, index, indexValid, indexExists };
  }

  append(ev) {
    fs.appendFileSync(this.journalFile, JSON.stringify(ev) + '\n');
  }

  saveIndex(engine) {
    const idx = {
      journalSeq: engine.journal.length,
      queues: [...engine.queues.entries()].map(([k, v]) => [k, [...v]]),
    };
    idx.checksum = sha(stable({ journalSeq: idx.journalSeq, queues: idx.queues }));
    const tmp = this.indexFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(idx));
    fs.renameSync(tmp, this.indexFile);
    return idx;
  }
}

function queuesMatch(indexQueues, engine) {
  const a = stable([...indexQueues].map(([k, v]) => [k, [...v]]).sort());
  const b = stable([...engine.queues.entries()].map(([k, v]) => [k, [...v]]).sort());
  return a === b;
}

function loadEngine(dir) {
  const store = new Store(dir);
  const { events, index, indexValid, indexExists } = store.load();
  const engine = Engine.replay(events);
  const stale = !indexValid || index.journalSeq !== events.length || !queuesMatch(index.queues, engine);
  const rebuilt = stale && (indexExists || events.length > 0);
  if (stale) store.saveIndex(engine);
  return { engine, store, rebuilt };
}

module.exports = { Store, loadEngine };
