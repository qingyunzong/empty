// Crash-safe persistence.
//
//  - events.jsonl: append-only op log (fsync per append); replay is the
//    source of truth for the engine state.
//  - batches.json: derived batch-queue snapshot written atomically
//    (tmp file -> fsync -> rename) inside a {checksum, data} envelope.
//    A crash mid-write leaves either a stale .tmp or a torn/corrupt main
//    file; both are detected on open and the queue is rebuilt by replay.
import fs from 'node:fs';
import path from 'node:path';
import { Engine, applyOp, sha256 } from './engine.js';

function writeFileAtomic(file, data) {
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function appendFileSyncFsync(file, data) {
  const fd = fs.openSync(file, 'a');
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function replayEvents(lines) {
  const engine = new Engine();
  for (const line of lines) {
    if (line.trim()) applyOp(engine, JSON.parse(line));
  }
  return engine;
}

export class Store {
  constructor(dir, engine) {
    this.dir = dir;
    this.engine = engine;
    this.eventsFile = path.join(dir, 'events.jsonl');
    this.queueFile = path.join(dir, 'batches.json');
  }

  static open(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const eventsFile = path.join(dir, 'events.jsonl');
    const lines = fs.existsSync(eventsFile)
      ? fs.readFileSync(eventsFile, 'utf8').split('\n')
      : [];
    const engine = replayEvents(lines);
    const store = new Store(dir, engine);
    if (!store.loadQueue()) store.saveQueue(); // torn/stale/missing -> rebuild
    return store;
  }

  apply(cmd) {
    const diff = applyOp(this.engine, cmd);
    if (cmd.op !== 'dump') {
      appendFileSyncFsync(this.eventsFile, `${JSON.stringify(cmd)}\n`);
      this.saveQueue();
    }
    return diff;
  }

  queuePayload() {
    const state = this.engine.serialize();
    return JSON.stringify({ stateHash: this.engine.stateHash(), batches: state.batches, tasks: state.tasks });
  }

  saveQueue() {
    const data = this.queuePayload();
    writeFileAtomic(this.queueFile, JSON.stringify({ checksum: sha256(data), data }));
  }

  // Returns the decoded queue when intact and consistent with replayed state,
  // otherwise null (caller rebuilds from the event log).
  loadQueue() {
    let raw;
    try {
      raw = fs.readFileSync(this.queueFile, 'utf8');
    } catch {
      return null;
    }
    try {
      const env = JSON.parse(raw);
      if (typeof env.checksum !== 'string' || typeof env.data !== 'string') return null;
      if (sha256(env.data) !== env.checksum) return null; // torn write
      const payload = JSON.parse(env.data);
      if (payload.stateHash !== this.engine.stateHash()) return null; // stale
      return payload;
    } catch {
      return null;
    }
  }
}
