import fs from 'node:fs';
import { Journal, scanChunks } from './journal.js';
import { emptyState, applyOp, validateOp, inverseOp, deepClone, checkAcyclic } from './state.js';
import { solveSchedule } from './scheduler.js';
import { err, CODES } from './errors.js';
import { canonicalJson, sha256hex, hashValue } from './canon.js';

const GENESIS = 'GENESIS';

function recordHash(rec) {
  const { hash, ...rest } = rec;
  return sha256hex(rec.parent + '\n' + canonicalJson(rest));
}

export class Store {
  constructor(journal) {
    this.journal = journal;
    this.state = emptyState();
    this.records = [];
    this.recovered = false;
  }

  static init(dir, opts) {
    Journal.init(dir, opts);
    return Store.open(dir, opts);
  }

  static open(dir, { strict = false, snapshotEvery } = {}) {
    const journal = new Journal(dir, { snapshotEvery });
    const store = new Store(journal);
    const { snapshot, chunks, recovered } = journal.load({
      strict,
      acceptSnapshot: (snap, validChunks) =>
        snap.seq === 0 ||
        validChunks.some((c) => c.record.seq === snap.seq && c.record.hash === snap.tipHash),
    });
    store.state = snapshot ? deepClone(snapshot.state) : emptyState();
    store.recovered = recovered;
    store.loadedSnapshot = snapshot;
    store._prevHash = GENESIS;
    store._prevSeq = 0;
    const baseOffset = snapshot ? snapshot.logOffset : 0;
    for (const { offset, record: rec } of chunks) {
      store._verifyLink(rec);
      if (offset >= baseOffset) {
        for (const op of rec.ops) applyOp(store.state, op);
      }
    }
    return store;
  }

  _verifyLink(rec) {
    const expectParent = this._prevHash;
    if (rec.parent !== expectParent || recordHash(rec) !== rec.hash) {
      throw err(CODES.E_CRC, `audit chain broken at seq ${rec.seq}`);
    }
    this.records.push(rec);
    this._prevHash = rec.hash;
    this._prevSeq = rec.seq;
  }

  // Effective (non-undone) commit stack, derived from the full history.
  effectiveStack() {
    const byHash = new Map(this.records.map((r) => [r.hash, r]));
    const stack = [];
    for (const rec of this.records) {
      if (rec.kind === 'commit') stack.push(rec);
      else if (rec.kind === 'undo') {
        if (stack.length && stack[stack.length - 1].hash === rec.of) stack.pop();
      } else if (rec.kind === 'redo') {
        const orig = byHash.get(rec.of);
        if (orig) stack.push(orig);
      }
    }
    return stack;
  }

  _appendRecord(kind, ops, inverse, of = null) {
    const rec = {
      v: 1,
      kind,
      seq: this._prevSeq + 1,
      parent: this._prevHash,
      ops: deepClone(ops),
      inverse: deepClone(inverse),
      ...(of ? { of } : {}),
    };
    rec.hash = recordHash(rec);
    for (const op of rec.ops) applyOp(this.state, op);
    this.journal.append(rec);
    this.records.push(rec);
    this._prevHash = rec.hash;
    this._prevSeq = rec.seq;
    this.journal.maybeSnapshot(rec.seq, this.state, rec.hash);
    return rec;
  }

  // Validate ops, generate inverses, append one commit record.
  commit(ops, { skipPrecedenceCheck = false } = {}) {
    const inverse = [];
    const trial = deepClone(this.state);
    for (const op of ops) {
      validateOp(trial, op);
      inverse.unshift(inverseOp(trial, op));
      applyOp(trial, op);
    }
    if (!skipPrecedenceCheck) checkAcyclic(trial); // E_PRECEDENCE on cycles
    return this._appendRecord('commit', ops, inverse);
  }

  undo() {
    const stack = this.effectiveStack();
    if (stack.length === 0) throw err(CODES.E_STATE, 'nothing to undo');
    const target = stack[stack.length - 1];
    return this._appendRecord('undo', target.inverse, target.ops, target.hash);
  }

  redo() {
    const tip = this.records[this.records.length - 1];
    if (!tip || tip.kind !== 'undo') {
      throw err(CODES.E_DIVERGED, 'history tail has diverged; redo is not valid');
    }
    const orig = this.records.find((r) => r.hash === tip.of);
    if (!orig) throw err(CODES.E_DIVERGED, 'undo target missing from history');
    return this._appendRecord('redo', orig.ops, orig.inverse, orig.hash);
  }

  schedule() {
    const sol = solveSchedule(this.state); // throws E_BUDGET / E_PRECEDENCE
    const rec = this.commit([{ kind: 'setSchedule', schedule: sol }], { skipPrecedenceCheck: true });
    return { solution: sol, record: rec };
  }

  snapshot() {
    return this.journal.writeSnapshot(this._prevSeq, this.state, this._prevHash);
  }

  // Full audit chain read from offset 0, verified from GENESIS.
  auditChain() {
    const buf = fs.readFileSync(this.journal.logPath);
    const { chunks, corruptAt, reason } = scanChunks(buf, 0);
    if (corruptAt !== null) throw err(CODES.E_CRC, `journal corrupt at offset ${corruptAt}: ${reason}`);
    let parent = GENESIS;
    return chunks.map((c) => {
      const rec = c.record;
      if (rec.parent !== parent || recordHash(rec) !== rec.hash) {
        throw err(CODES.E_CRC, `audit chain broken at seq ${rec.seq}`);
      }
      parent = rec.hash;
      return { seq: rec.seq, kind: rec.kind, hash: rec.hash, parent: rec.parent, of: rec.of ?? null };
    });
  }

  status() {
    const stack = this.effectiveStack();
    const tip = this.records[this.records.length - 1] ?? null;
    return {
      seq: this._prevSeq,
      tip: tip ? tip.hash : null,
      tipKind: tip ? tip.kind : null,
      stateHash: hashValue(this.state),
      effectiveTip: stack.length ? stack[stack.length - 1].hash : null,
      canUndo: stack.length > 0,
      canRedo: !!tip && tip.kind === 'undo',
      recovered: this.recovered,
      records: this.records.map((r) => ({ seq: r.seq, kind: r.kind, hash: r.hash, parent: r.parent, of: r.of ?? null })),
    };
  }
}
