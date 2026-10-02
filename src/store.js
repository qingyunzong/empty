import fs from 'node:fs';
import path from 'node:path';
import { EvidenceGraph } from './graph.js';
import { canonical, sha256hex, hashEvent, GENESIS_HASH } from './util.js';
import { err, E_WAL, E_HASH, E_CRASH } from './errors.js';

// Well-defined crash injection points:
//   after_append  - WAL record appended+fsynced, before in-memory index update
//   before_index  - graph updated in memory, before the persisted index is written
//   after_snapshot- snapshot file written, before WAL truncation
export const FAULTS = Object.freeze({
  AFTER_APPEND: 'after_append',
  BEFORE_INDEX: 'before_index',
  AFTER_SNAPSHOT: 'after_snapshot',
});

export class Store {
  constructor(dir, { faultAt } = {}) {
    this.dir = dir;
    this.faultAt = faultAt ?? process.env.EVIDENCE_FAULT_AT ?? null;
    this.walPath = path.join(dir, 'wal.log');
    this.snapshotPath = path.join(dir, 'snapshot.json');
    this.indexPath = path.join(dir, 'index.json');
    this.graph = new EvidenceGraph();
    this.lastSeq = 0;
    this.headHash = GENESIS_HASH;
    this.crashed = false;
  }

  static open(dir, opts) {
    const store = new Store(dir, opts);
    store.recover();
    return store;
  }

  inject(point) {
    if (this.faultAt === point) {
      this.crashed = true; // a real crash kills the process; refuse further use
      throw err(E_CRASH, `simulated crash at fault point: ${point}`, { faultPoint: point });
    }
  }

  assertUsable() {
    if (this.crashed) throw err(E_CRASH, 'store instance is dead after a simulated crash; reopen to recover');
  }

  // Recovery: load the latest consistent snapshot (verifying its self-hash),
  // then replay WAL records after it while verifying the hash chain.
  recover() {
    fs.mkdirSync(this.dir, { recursive: true });
    let snapshotSeq = 0;
    if (fs.existsSync(this.snapshotPath)) {
      const snap = readJsonFile(this.snapshotPath, E_HASH, 'snapshot');
      const expect = sha256hex(canonical({ lastSeq: snap.lastSeq, headHash: snap.headHash, state: snap.state }));
      if (expect !== snap.stateHash) {
        throw err(E_HASH, 'snapshot integrity check failed: stateHash mismatch');
      }
      this.graph = EvidenceGraph.fromState(snap.state);
      this.lastSeq = snap.lastSeq;
      this.headHash = snap.headHash;
      snapshotSeq = snap.lastSeq;
    }
    if (fs.existsSync(this.walPath)) {
      const records = readWal(this.walPath);
      let expectedPrev = records.length > 0 && records[0].seq === 1 ? GENESIS_HASH : this.headHash;
      for (const record of records) {
        if (record.prev !== expectedPrev) {
          throw err(E_HASH, `hash chain broken at seq ${record.seq}: prev does not link`);
        }
        if (hashEvent(record) !== record.hash) {
          throw err(E_HASH, `event hash mismatch at seq ${record.seq}`);
        }
        if (record.seq <= snapshotSeq) {
          if (record.seq === snapshotSeq && record.hash !== this.headHash) {
            throw err(E_HASH, `WAL diverges from snapshot at seq ${record.seq}`);
          }
        } else {
          if (record.seq !== this.lastSeq + 1) {
            throw err(E_WAL, `sequence gap: expected ${this.lastSeq + 1}, got ${record.seq}`);
          }
          this.graph.apply({ type: record.type, payload: record.payload });
          this.lastSeq = record.seq;
          this.headHash = record.hash;
        }
        expectedPrev = record.hash;
      }
    }
    this.persistIndex();
    return this;
  }

  commit(type, payload) {
    this.assertUsable();
    const event = { seq: this.lastSeq + 1, type, payload, prev: this.headHash };
    event.hash = hashEvent(event);
    this.graph.check(event); // validate before anything hits disk
    appendWalRecord(this.walPath, event);
    this.inject(FAULTS.AFTER_APPEND);
    this.graph.apply(event);
    this.lastSeq = event.seq;
    this.headHash = event.hash;
    this.inject(FAULTS.BEFORE_INDEX);
    this.persistIndex();
    return event;
  }

  snapshot() {
    this.assertUsable();
    const snap = { lastSeq: this.lastSeq, headHash: this.headHash, state: this.graph.toState() };
    snap.stateHash = sha256hex(canonical({ lastSeq: snap.lastSeq, headHash: snap.headHash, state: snap.state }));
    writeFileAtomic(this.snapshotPath, JSON.stringify(snap));
    this.inject(FAULTS.AFTER_SNAPSHOT);
    const fd = fs.openSync(this.walPath, 'w');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    this.persistIndex();
    return snap;
  }

  persistIndex() {
    const index = { lastSeq: this.lastSeq, headHash: this.headHash, nodes: this.graph.materialize() };
    writeFileAtomic(this.indexPath, JSON.stringify(index));
  }

  // Verify snapshot integrity + full WAL hash chain. Returns a report; throws
  // EvidenceError(E_WAL|E_HASH) on failure.
  static verify(dir) {
    const store = Store.open(dir);
    return {
      ok: true,
      lastSeq: store.lastSeq,
      headHash: store.headHash,
      snapshot: fs.existsSync(store.snapshotPath),
      nodes: Object.keys(store.graph.materialize()).length,
    };
  }
}

function readJsonFile(file, code, what) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw err(E_WAL, `cannot read ${what}: ${e.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw err(code, `${what} is not valid JSON`);
  }
}

function readWal(walPath) {
  let raw;
  try {
    raw = fs.readFileSync(walPath, 'utf8');
  } catch (e) {
    throw err(E_WAL, `cannot read WAL: ${e.message}`);
  }
  const lines = raw.split('\n').filter((l) => l.length > 0);
  return lines.map((line, i) => {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      throw err(E_WAL, `corrupt WAL record at line ${i + 1}`);
    }
    if (typeof record.seq !== 'number' || typeof record.hash !== 'string' || typeof record.prev !== 'string') {
      throw err(E_WAL, `malformed WAL record at line ${i + 1}`);
    }
    return record;
  });
}

function appendWalRecord(walPath, event) {
  let fd;
  try {
    fd = fs.openSync(walPath, 'a');
    fs.writeSync(fd, JSON.stringify(event) + '\n');
    fs.fsyncSync(fd);
  } catch (e) {
    throw err(E_WAL, `WAL append failed: ${e.message}`);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function writeFileAtomic(file, contents) {
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, contents);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}
