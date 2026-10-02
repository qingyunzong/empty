import fs from 'node:fs';
import path from 'node:path';
import { Graph } from './graph.js';
import { canonical, sha256 } from './hash.js';

export const GENESIS = 'GENESIS';
export const CRASH_EXIT_CODE = 75;
export const LOG_FILE = 'append-audit.log';
export const CHECKPOINT_FILE = 'checkpoint.json';
export const CHECKPOINT_TMP_FILE = 'checkpoint.json.tmp';

function eventOf(entry) {
  return { seq: entry.seq, type: entry.type, args: entry.args, prevHash: entry.prevHash };
}

function entryHash(entry) {
  return sha256(canonical(eventOf(entry)));
}

function applyEvent(graph, entry) {
  if (entry.type === 'add-edge') graph.addEdge(entry.args.from, entry.args.to);
  else if (entry.type === 'delete-edge') graph.deleteEdge(entry.args.from, entry.args.to);
  else throw new Error(`unknown event type: ${entry.type}`);
}

function stateRoot(state) {
  return sha256(canonical(state));
}

function readLog(logPath) {
  if (!fs.existsSync(logPath)) return [];
  const text = fs.readFileSync(logPath, 'utf8');
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.logPath = path.join(dir, LOG_FILE);
    this.checkpointPath = path.join(dir, CHECKPOINT_FILE);
    this.checkpointTmpPath = path.join(dir, CHECKPOINT_TMP_FILE);
    fs.mkdirSync(dir, { recursive: true });
    this.graph = new Graph();
    this.lastSeq = 0;
    this.lastHash = GENESIS;
  }

  static load(dir) {
    const store = new Store(dir);
    store.recover();
    return store;
  }

  recover() {
    if (fs.existsSync(this.checkpointTmpPath)) fs.rmSync(this.checkpointTmpPath);

    let checkpointSeq = 0;
    if (fs.existsSync(this.checkpointPath)) {
      const checkpoint = JSON.parse(fs.readFileSync(this.checkpointPath, 'utf8'));
      this.graph = Graph.fromState(checkpoint.state);
      this.lastSeq = checkpoint.lastSeq;
      this.lastHash = checkpoint.lastHash;
      checkpointSeq = checkpoint.lastSeq;
    }

    let replayed = false;
    for (const entry of readLog(this.logPath)) {
      if (entry.seq <= checkpointSeq) continue; // already folded into checkpoint: never re-execute
      if (entry.seq !== this.lastSeq + 1) {
        throw new Error(`log sequence gap: expected seq ${this.lastSeq + 1}, found ${entry.seq}`);
      }
      if (entry.prevHash !== this.lastHash) {
        throw new Error(`hash chain broken at seq ${entry.seq}`);
      }
      if (entryHash(entry) !== entry.hash) {
        throw new Error(`entry hash mismatch at seq ${entry.seq}`);
      }
      applyEvent(this.graph, entry);
      this.lastSeq = entry.seq;
      this.lastHash = entry.hash;
      replayed = true;
    }

    if (replayed) this.writeCheckpoint();
  }

  commit(type, args, crash) {
    const event = { seq: this.lastSeq + 1, type, args, prevHash: this.lastHash };
    const hash = sha256(canonical(event));
    const line = JSON.stringify({ ...event, hash }) + '\n';

    const fd = fs.openSync(this.logPath, 'a');
    fs.writeSync(fd, line);
    fs.fsyncSync(fd);
    fs.closeSync(fd);

    if (crash === 'before-checkpoint') process.exit(CRASH_EXIT_CODE);

    applyEvent(this.graph, event);
    this.lastSeq = event.seq;
    this.lastHash = hash;
    this.writeCheckpoint();

    if (crash === 'after-checkpoint') process.exit(CRASH_EXIT_CODE);

    return hash;
  }

  writeCheckpoint() {
    const state = this.graph.toState();
    const checkpoint = {
      lastSeq: this.lastSeq,
      lastHash: this.lastHash,
      state,
      stateRoot: stateRoot(state),
      scc: this.graph.scc(),
    };
    const fd = fs.openSync(this.checkpointTmpPath, 'w');
    fs.writeSync(fd, JSON.stringify(checkpoint, null, 2) + '\n');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(this.checkpointTmpPath, this.checkpointPath);
  }
}

export function verifyHistory(dir) {
  const errors = [];
  const logPath = path.join(dir, LOG_FILE);
  const checkpointPath = path.join(dir, CHECKPOINT_FILE);

  const entries = readLog(logPath);

  // 1. Hash chain + full replay from genesis.
  const graph = new Graph();
  let prevHash = GENESIS;
  let expectedSeq = 1;
  const hashBySeq = new Map([[0, GENESIS]]);
  for (const entry of entries) {
    if (entry.seq !== expectedSeq) {
      errors.push(`seq ${entry.seq}: expected seq ${expectedSeq}`);
      expectedSeq = entry.seq;
    }
    if (entry.prevHash !== prevHash) {
      errors.push(`seq ${entry.seq}: prevHash does not match previous entry hash`);
    }
    if (entryHash(entry) !== entry.hash) {
      errors.push(`seq ${entry.seq}: entry hash mismatch (log tampered?)`);
    }
    try {
      applyEvent(graph, entry);
    } catch (err) {
      errors.push(`seq ${entry.seq}: ${err.message}`);
    }
    prevHash = entry.hash;
    hashBySeq.set(entry.seq, entry.hash);
    expectedSeq += 1;
  }

  // 2. Checkpoint consistency: state root, hash link, SCC.
  if (fs.existsSync(checkpointPath)) {
    const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
    const replayed = new Graph();
    for (const entry of entries) {
      if (entry.seq > checkpoint.lastSeq) break;
      try {
        applyEvent(replayed, entry);
      } catch {
        break;
      }
    }
    const replayedState = replayed.toState();
    const replayedRoot = stateRoot(replayedState);

    if (!hashBySeq.has(checkpoint.lastSeq)) {
      errors.push(`checkpoint lastSeq ${checkpoint.lastSeq} not present in log`);
    } else if (checkpoint.lastHash !== hashBySeq.get(checkpoint.lastSeq)) {
      errors.push('checkpoint lastHash does not match log entry hash');
    }
    if (canonical(checkpoint.state) !== canonical(replayedState)) {
      errors.push('checkpoint state does not match replay of log up to lastSeq');
    }
    if (checkpoint.stateRoot !== replayedRoot) {
      errors.push('checkpoint stateRoot mismatch');
    }
    const expectedScc = Graph.fromState(replayedState).scc();
    if (canonical(checkpoint.scc) !== canonical(expectedScc)) {
      errors.push('checkpoint SCC mismatch');
    }
    const lastLogSeq = entries.length > 0 ? entries[entries.length - 1].seq : 0;
    if (checkpoint.lastSeq !== lastLogSeq) {
      errors.push(`checkpoint lastSeq ${checkpoint.lastSeq} does not cover log (last seq ${lastLogSeq})`);
    }
    if (checkpoint.stateRoot !== stateRoot(graph.toState())) {
      errors.push('current state root does not match checkpoint stateRoot');
    }
  } else if (entries.length > 0) {
    errors.push('log is non-empty but checkpoint is missing');
  }

  return errors;
}
