// Crash-safe store: JSON snapshot + WAL + derived index.
// Fixed fault-injection points (env QC_CRASH_AT / option crashAt):
//   wal-append      -> after WAL append, before fsync      => recovery replays WAL
//   snapshot-rename -> after tmp snapshot fsync, pre-rename => recovery ignores half snapshot
//   index-update    -> after index file update             => recovery rebuilds index (no double count)

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { applyOp, enrichArgs, INITIAL_STATE } from './machine.js';
import { canonicalHash } from './hash.js';

export class WalChecksumError extends Error {
  constructor(message) { super(message); this.name = 'WalChecksumError'; this.code = 22; }
}

export class HashMismatchError extends Error {
  constructor(message) { super(message); this.name = 'HashMismatchError'; this.code = 23; }
}

export class SimulatedCrash extends Error {
  constructor(point) { super(`simulated crash at ${point}`); this.name = 'SimulatedCrash'; this.point = point; }
}

const SNAPSHOT = 'snapshot.json';
const SNAPSHOT_TMP = 'snapshot.json.tmp';
const WAL = 'wal.log';
const INDEX = 'index.json';

export function recordChecksum(rec) {
  return createHash('sha256')
    .update(JSON.stringify({ seq: rec.seq, op: rec.op, args: rec.args }))
    .digest('hex')
    .slice(0, 16);
}

export function readWal(walFile) {
  if (!fs.existsSync(walFile)) return [];
  const records = [];
  for (const line of fs.readFileSync(walFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch {
      throw new WalChecksumError('unparseable WAL record');
    }
    if (recordChecksum(rec) !== rec.checksum) {
      throw new WalChecksumError(`WAL record seq=${rec.seq} checksum mismatch`);
    }
    records.push(rec);
  }
  return records;
}

export function buildIndex(state) {
  const index = {
    opsApplied: state.lastSeq,
    auditEntries: state.audit.length,
    defectsOpen: 0, defectsMerged: 0, defectsClosed: 0, defectsScrapped: 0,
    ordersOpen: 0, ordersClosed: 0
  };
  for (const def of Object.values(state.defects)) {
    if (def.status === 'open') index.defectsOpen++;
    else if (def.status === 'merged') index.defectsMerged++;
    else if (def.status === 'closed') index.defectsClosed++;
    else if (def.status === 'scrapped') index.defectsScrapped++;
  }
  for (const order of Object.values(state.orders)) {
    if (order.status === 'open') index.ordersOpen++;
    else index.ordersClosed++;
  }
  return index;
}

export class Store {
  constructor(dir, { crashAt = null, crashMode = 'exit' } = {}) {
    this.dir = dir;
    this.crashAt = crashAt;
    this.crashMode = crashMode; // 'exit' (CLI, real process crash) | 'throw' (in-process tests)
    this.snapFile = path.join(dir, SNAPSHOT);
    this.tmpFile = path.join(dir, SNAPSHOT_TMP);
    this.walFile = path.join(dir, WAL);
    this.indexFile = path.join(dir, INDEX);
    this.lastAttemptedRec = null;
    fs.mkdirSync(dir, { recursive: true });
  }

  _maybeCrash(point) {
    if (this.crashAt !== point) return;
    if (this.crashMode === 'exit') process.exit(2);
    throw new SimulatedCrash(point);
  }

  // Recover state from disk: ignore half snapshot, load snapshot, replay WAL tail,
  // rebuild index from scratch. Pure read-only (does not delete or write anything).
  recover() {
    const report = { ignoredHalfSnapshot: false, replayedFromSeq: 0, replayedRecords: 0, rebuiltIndex: true };
    let state = structuredClone(INITIAL_STATE);
    if (fs.existsSync(this.snapFile)) {
      state = JSON.parse(fs.readFileSync(this.snapFile, 'utf8')).state;
    }
    if (fs.existsSync(this.tmpFile)) report.ignoredHalfSnapshot = true;
    report.replayedFromSeq = state.lastSeq;
    let replayed = 0;
    for (const rec of readWal(this.walFile)) {
      if (rec.seq <= state.lastSeq) continue; // already folded into snapshot: skip, never double-count
      applyOp(state, rec);
      replayed++;
    }
    report.replayedRecords = replayed;
    return { state, index: buildIndex(state), report };
  }

  // Cross-check: hash of recovered state must equal hash of a from-scratch WAL replay.
  checkConsistency(state) {
    const reference = structuredClone(INITIAL_STATE);
    for (const rec of readWal(this.walFile)) applyOp(reference, rec);
    const a = canonicalHash(state);
    const b = canonicalHash(reference);
    if (a !== b) {
      throw new HashMismatchError(`state hash mismatch before/after recovery: ${a} != ${b}`);
    }
    return a;
  }

  // Persist a recovered state as the new snapshot + index (used by crash-recover).
  persistRecovered({ state, index }) {
    this.checkConsistency(state); // throws exit-23 before touching disk
    if (fs.existsSync(this.tmpFile)) fs.rmSync(this.tmpFile);
    fs.writeFileSync(this.tmpFile, JSON.stringify({ state }));
    const fd = fs.openSync(this.tmpFile, 'r');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(this.tmpFile, this.snapFile);
    fs.writeFileSync(this.indexFile, JSON.stringify(index));
    return state;
  }

  apply(op, args) {
    const { state } = this.recover();
    const seq = state.lastSeq + 1;
    const rec = { seq, op, args: enrichArgs(state, op, args) };
    rec.checksum = recordChecksum(rec);
    const next = structuredClone(state);
    applyOp(next, rec); // dry-run validation BEFORE anything hits disk
    this.lastAttemptedRec = rec;

    fs.appendFileSync(this.walFile, JSON.stringify(rec) + '\n');
    this._maybeCrash('wal-append'); // fault point 1: appended but not fsynced
    let fd = fs.openSync(this.walFile, 'r');
    fs.fsyncSync(fd);
    fs.closeSync(fd);

    fs.writeFileSync(this.tmpFile, JSON.stringify({ state: next }));
    fd = fs.openSync(this.tmpFile, 'r');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    this._maybeCrash('snapshot-rename'); // fault point 2: half snapshot left behind
    fs.renameSync(this.tmpFile, this.snapFile);

    fs.writeFileSync(this.indexFile, JSON.stringify(buildIndex(next)));
    this._maybeCrash('index-update'); // fault point 3: index updated, crash right after
    return rec;
  }
}
