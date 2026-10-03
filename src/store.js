// Persistence: append-only WAL with a sha256 hash chain, plus snapshots.
//
// Failure points (crash-injection hooks, used by tests):
//   FP1 afterAppend   - WAL entry appended, before in-memory index update.
//                       Recovery replays the entry from the WAL.
//   FP2 beforeIndex   - index updated in memory, before the index checkpoint
//                       (index.json) is persisted. A crash may leave a torn
//                       index.json; recovery detects and ignores it, then
//                       rebuilds the index from snapshot + WAL replay.
//   FP3 afterSnapshot - snapshot committed, before WAL compaction. The WAL
//                       still contains already-snapshotted events; recovery
//                       skips events with seq <= snapshot.seq (idempotent).
//
// Recovery: load the newest consistent snapshot (checksum verified), verify
// the WAL hash chain from the snapshot hash (or genesis), truncate a torn
// tail line, then replay events with seq > snapshot.seq.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { E } from './errors.js';
import {
  createState,
  applyEvent,
  validateEvent,
  normalizeDerived,
  evaluate,
} from './graph.js';

const GENESIS = '0'.repeat(64);
const WAL_FILE = 'wal.log';
const SNAP_FILE = 'snapshot.json';
const INDEX_FILE = 'index.json';

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function hashEvent(event) {
  const { seq, ts, type, payload, prev } = event;
  return sha256(stableStringify({ seq, ts, type, payload, prev }));
}

function atomicWrite(file, content) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

export class Store {
  static open(dir, options = {}) {
    fs.mkdirSync(dir, { recursive: true });
    const store = new Store(dir, options);
    store._recover({ strict: false });
    return store;
  }

  constructor(dir, { faults = {} } = {}) {
    this.dir = dir;
    this.faults = faults;
    this.walPath = path.join(dir, WAL_FILE);
    this.snapPath = path.join(dir, SNAP_FILE);
    this.indexPath = path.join(dir, INDEX_FILE);
    this.state = createState();
    this.lastSeq = 0;
    this.lastHash = GENESIS;
    this.snapshotSeq = 0;
    this.tail = []; // events after the snapshot, kept for compaction
  }

  _fault(point) {
    if (typeof this.faults[point] === 'function') this.faults[point]();
  }

  append(type, payload) {
    const normalized = type === 'ADD_DERIVED' ? normalizeDerived(payload) : payload;
    validateEvent(this.state, type, normalized);
    const event = {
      seq: this.lastSeq + 1,
      ts: Date.now(),
      type,
      payload: normalized,
      prev: this.lastHash,
    };
    event.hash = hashEvent(event);
    fs.appendFileSync(this.walPath, `${JSON.stringify(event)}\n`);
    this._fault('afterAppend'); // FP1
    applyEvent(this.state, type, normalized);
    this.tail.push(event);
    this.lastSeq = event.seq;
    this.lastHash = event.hash;
    this._fault('beforeIndex'); // FP2
    this._writeIndexCheckpoint();
    return event;
  }

  _writeIndexCheckpoint() {
    atomicWrite(
      this.indexPath,
      JSON.stringify({ appliedSeq: this.lastSeq, appliedHash: this.lastHash }),
    );
  }

  snapshot() {
    const core = { seq: this.lastSeq, hash: this.lastHash, state: this.state };
    const file = { ...core, checksum: sha256(stableStringify(core)) };
    atomicWrite(this.snapPath, JSON.stringify(file));
    this.snapshotSeq = this.lastSeq;
    this._fault('afterSnapshot'); // FP3
    this._compact();
    return { seq: file.seq, hash: file.hash };
  }

  _compact() {
    const keep = this.tail.filter((e) => e.seq > this.snapshotSeq);
    const content = keep.map((e) => `${JSON.stringify(e)}\n`).join('');
    atomicWrite(this.walPath, content);
    this.tail = keep;
  }

  status(nodeId) {
    return evaluate(this.state, nodeId);
  }

  // Verify snapshot checksum + full WAL hash chain. Read-only and strict:
  // a torn tail is reported as E_WAL instead of being repaired.
  verify() {
    this._verifyAll({ strict: true, repair: false });
    return { ok: true, events: this.lastSeq, snapshotSeq: this.snapshotSeq };
  }

  _recover({ strict }) {
    this._verifyAll({ strict, repair: !strict });
  }

  _verifyAll({ strict, repair }) {
    // 1. Snapshot
    let snapshot = null;
    if (fs.existsSync(this.snapPath)) {
      let parsed;
      try {
        parsed = JSON.parse(fs.readFileSync(this.snapPath, 'utf8'));
      } catch {
        throw E.hash('snapshot.json is not valid JSON');
      }
      const { checksum, ...core } = parsed;
      if (sha256(stableStringify(core)) !== checksum) {
        throw E.hash('snapshot checksum mismatch');
      }
      snapshot = core;
    }
    this.snapshotSeq = snapshot ? snapshot.seq : 0;

    // 2. Index checkpoint (advisory only; torn checkpoints are ignored)
    let index = null;
    if (fs.existsSync(this.indexPath)) {
      try {
        index = JSON.parse(fs.readFileSync(this.indexPath, 'utf8'));
      } catch {
        index = null; // FP2: torn index checkpoint, rebuilt from WAL
      }
    }

    // 3. WAL: parse lines, verify hash chain, repair torn tail
    const baseHash = snapshot ? snapshot.hash : GENESIS;
    const events = [];
    if (fs.existsSync(this.walPath)) {
      const raw = fs.readFileSync(this.walPath, 'utf8');
      let offset = 0;
      const lines = raw.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const lineStart = offset;
        offset += line.length + 1;
        if (line === '' && i === lines.length - 1) break; // trailing newline
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          const isTail = i === lines.length - 1 || lines.slice(i + 1).every((l) => l === '');
          if (isTail && repair) {
            fs.truncateSync(this.walPath, lineStart); // torn tail from crash
            break;
          }
          throw E.wal(`corrupt WAL line ${i + 1}`);
        }
        events.push(event);
      }
    }

    // 4. Chain + sequence verification
    let expectedPrev = GENESIS;
    let expectedSeq = 1;
    if (events.length > 0 && events[0].seq !== 1) {
      if (!snapshot || events[0].seq !== snapshot.seq + 1) {
        throw E.wal(`WAL starts at seq ${events[0].seq} but snapshot covers seq ${this.snapshotSeq}`);
      }
      expectedPrev = snapshot.hash;
      expectedSeq = snapshot.seq + 1;
    }
    for (const event of events) {
      if (event.seq !== expectedSeq) {
        throw E.wal(`WAL sequence gap: expected seq ${expectedSeq}, got ${event.seq}`);
      }
      if (event.prev !== expectedPrev) {
        throw E.hash(`hash chain broken at seq ${event.seq}`);
      }
      if (hashEvent(event) !== event.hash) {
        throw E.hash(`event hash mismatch at seq ${event.seq}`);
      }
      if (snapshot && event.seq === snapshot.seq && event.hash !== snapshot.hash) {
        throw E.hash(`snapshot hash does not match WAL event seq ${event.seq}`);
      }
      expectedPrev = event.hash;
      expectedSeq += 1;
    }

    // 5. Index/WAL cross-check: index ahead of WAL means lost entries
    if (index && index.appliedSeq > (events.at(-1)?.seq ?? this.snapshotSeq)) {
      throw E.wal(
        `index checkpoint at seq ${index.appliedSeq} is ahead of WAL (seq ${events.at(-1)?.seq ?? 0})`,
      );
    }

    // 6. Materialize: snapshot state + replay of newer events (idempotent by seq)
    this.state = snapshot ? structuredClone(snapshot.state) : createState();
    this.tail = [];
    for (const event of events) {
      if (event.seq <= this.snapshotSeq) continue; // FP3: already in snapshot
      applyEvent(this.state, event.type, event.payload);
      this.tail.push(event);
    }
    this.lastSeq = events.at(-1)?.seq ?? this.snapshotSeq;
    this.lastHash = events.at(-1)?.hash ?? baseHash;
  }
}
