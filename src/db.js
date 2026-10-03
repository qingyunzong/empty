'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { appendRecord, readWal } = require('./wal');
const { DbError } = require('./errors');

const SEP = '\0';
function keyOf(pallet, lot) {
  return pallet + SEP + lot;
}

class SimulatedCrash extends Error {
  constructor(point) {
    super(`simulated crash at ${point}`);
    this.name = 'SimulatedCrash';
    this.code = 'E_CRASH';
    this.point = point;
  }
}

function assertName(kind, value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes(SEP)) {
    throw new DbError('E_ARG', `${kind} must be a non-empty string without NUL`);
  }
}

class Database {
  static open(dir, opts = {}) {
    const db = new Database(dir, opts);
    db._recover();
    return db;
  }

  constructor(dir, opts) {
    this.dir = dir;
    this.walPath = path.join(dir, 'wal.log');
    this.crashAt = opts.crashAt || null; // 'after_records' | 'after_commit'
    this.crashed = false;
    this.versions = new Map(); // key -> [{quarantine, cmin, cmax}]
    this.index = new Map(); // key -> {pallet, lot, quarantine} (live only)
    this.lastTs = 0;
    this.lastTxId = 0;
  }

  // ---- recovery ----

  _recover() {
    fs.mkdirSync(this.dir, { recursive: true });
    const records = readWal(this.walPath);
    const txns = new Map(); // txId -> {id, ops, committed, cts}
    for (const rec of records) {
      if (typeof rec !== 'object' || rec === null || typeof rec.tx !== 'number') {
        throw new DbError('E_CORRUPT', 'wal: malformed record');
      }
      if (rec.t === 'begin') {
        if (txns.has(rec.tx)) throw new DbError('E_CORRUPT', `wal: duplicate begin tx ${rec.tx}`);
        txns.set(rec.tx, { id: rec.tx, ops: [], committed: false, cts: 0 });
      } else if (rec.t === 'rec') {
        const txn = txns.get(rec.tx);
        if (!txn) throw new DbError('E_CORRUPT', `wal: record for unknown tx ${rec.tx}`);
        txn.ops.push(validateOp(rec.op));
      } else if (rec.t === 'commit') {
        const txn = txns.get(rec.tx);
        if (!txn || typeof rec.cts !== 'number') {
          throw new DbError('E_CORRUPT', `wal: bad commit for tx ${rec.tx}`);
        }
        txn.committed = true;
        txn.cts = rec.cts;
      } else {
        throw new DbError('E_CORRUPT', `wal: unknown record type ${String(rec.t)}`);
      }
    }
    const committed = [...txns.values()].filter((t) => t.committed).sort((a, b) => a.cts - b.cts);
    for (const txn of committed) {
      this._apply(txn.ops, txn.cts);
      this.lastTs = Math.max(this.lastTs, txn.cts);
    }
    for (const txn of txns.values()) this.lastTxId = Math.max(this.lastTxId, txn.id);
    // Uncommitted transactions (crash before commit marker) are never
    // applied: their tentative records are rolled back by omission.
    this._rebuildIndex();
  }

  _rebuildIndex() {
    this.index.clear();
    for (const [key, chain] of this.versions) {
      const live = chain.find((v) => v.cmax === Infinity);
      if (live) {
        const [pallet, lot] = key.split(SEP);
        this.index.set(key, { pallet, lot, quarantine: live.quarantine });
      }
    }
  }

  // ---- version chain primitives ----

  _liveVersion(key) {
    const chain = this.versions.get(key);
    if (!chain) return null;
    return chain.find((v) => v.cmax === Infinity) || null;
  }

  _versionAt(key, ts) {
    const chain = this.versions.get(key);
    if (!chain) return null;
    return chain.find((v) => v.cmin <= ts && ts < v.cmax) || null;
  }

  _endVersion(key, cts) {
    const live = this._liveVersion(key);
    if (live) live.cmax = cts;
    this.index.delete(key);
  }

  _setVersion(pallet, lot, quarantine, cts) {
    const key = keyOf(pallet, lot);
    let chain = this.versions.get(key);
    if (!chain) {
      chain = [];
      this.versions.set(key, chain);
    }
    const live = chain.find((v) => v.cmax === Infinity);
    if (live) live.cmax = cts;
    chain.push({ quarantine, cmin: cts, cmax: Infinity });
    this.index.set(key, { pallet, lot, quarantine });
  }

  _apply(ops, cts) {
    for (const op of ops) {
      if (op.type === 'put') {
        this._setVersion(op.pallet, op.lot, op.quarantine, cts);
      } else {
        this._endVersion(keyOf(op.from, op.lot), cts);
        this._setVersion(op.to, op.lot, op.quarantine, cts);
      }
    }
  }

  _crashPoint(point) {
    if (this.crashAt === point) {
      this.crashed = true;
      throw new SimulatedCrash(point);
    }
  }

  // ---- public API ----

  begin() {
    if (this.crashed) throw new DbError('E_CRASHED', 'database instance is dead after simulated crash');
    return new Transaction(this);
  }

  read(pallet, lot) {
    const v = this._liveVersion(keyOf(pallet, lot));
    return v ? { pallet, lot, quarantine: v.quarantine } : null;
  }

  dump() {
    const pallets = {};
    for (const entry of this.dumpIndex()) {
      (pallets[entry.pallet] ||= {})[entry.lot] = { quarantine: entry.quarantine };
    }
    return { pallets };
  }

  dumpIndex() {
    return [...this.index.values()].sort((a, b) =>
      a.pallet < b.pallet ? -1 : a.pallet > b.pallet ? 1 : a.lot < b.lot ? -1 : a.lot > b.lot ? 1 : 0,
    ).map((e) => ({ ...e }));
  }
}

function validateOp(op) {
  if (typeof op !== 'object' || op === null) throw new DbError('E_CORRUPT', 'wal: bad op');
  if (op.type === 'put') {
    if (typeof op.pallet !== 'string' || typeof op.lot !== 'string' || typeof op.quarantine !== 'boolean') {
      throw new DbError('E_CORRUPT', 'wal: bad put op');
    }
  } else if (op.type === 'move') {
    if (typeof op.from !== 'string' || typeof op.to !== 'string' || typeof op.lot !== 'string' || typeof op.quarantine !== 'boolean') {
      throw new DbError('E_CORRUPT', 'wal: bad move op');
    }
  } else {
    throw new DbError('E_CORRUPT', 'wal: unknown op type');
  }
  return op;
}

class Transaction {
  constructor(db) {
    this.db = db;
    this.snapshotTs = db.lastTs;
    this.ops = [];
    this.done = false;
  }

  read(pallet, lot) {
    const v = this.db._versionAt(keyOf(pallet, lot), this.snapshotTs);
    return v ? { pallet, lot, quarantine: v.quarantine } : null;
  }

  put(pallet, lot, quarantine = false) {
    assertName('pallet', pallet);
    assertName('lot', lot);
    if (this.read(pallet, lot)) {
      throw new DbError('E_DUP', `lot ${lot} already exists on pallet ${pallet}`);
    }
    this.ops.push({ type: 'put', pallet, lot, quarantine: quarantine === true });
  }

  move(from, to, lot, quarantine) {
    assertName('from', from);
    assertName('to', to);
    assertName('lot', lot);
    const current = this.read(from, lot);
    if (!current) {
      throw new DbError('E_NOT_FOUND', `lot ${lot} not on source pallet ${from} at snapshot`);
    }
    const q = quarantine === undefined ? current.quarantine : quarantine === true;
    this.ops.push({ type: 'move', from, to, lot, quarantine: q });
  }

  transfer(from, to, lots, quarantine) {
    if (!Array.isArray(lots) || lots.length === 0) {
      throw new DbError('E_ARG', 'lots must be a non-empty array');
    }
    for (const lot of lots) this.move(from, to, lot, quarantine);
  }

  commit() {
    const db = this.db;
    if (this.done) throw new DbError('E_TXN_DONE', 'transaction already finished');
    if (db.crashed) throw new DbError('E_CRASHED', 'database instance is dead after simulated crash');
    this.done = true;
    this._validate();
    const txId = ++db.lastTxId;
    const cts = db.lastTs + 1;
    appendRecord(db.walPath, { t: 'begin', tx: txId });
    for (const op of this.ops) appendRecord(db.walPath, { t: 'rec', tx: txId, op });
    db._crashPoint('after_records');
    appendRecord(db.walPath, { t: 'commit', tx: txId, cts });
    db._crashPoint('after_commit');
    db.lastTs = cts;
    db._apply(this.ops, cts);
    return { txId, commitTs: cts };
  }

  _validate() {
    const db = this.db;
    const stagedTargets = new Set();
    const stagedSources = new Set();
    for (const op of this.ops) {
      if (op.type === 'put') {
        const key = keyOf(op.pallet, op.lot);
        if (db._liveVersion(key)) throw new DbError('E_DUP', `lot ${op.lot} already exists on pallet ${op.pallet}`);
        if (stagedTargets.has(key)) throw new DbError('E_DUP', `duplicate staged put of lot ${op.lot} on pallet ${op.pallet}`);
        stagedTargets.add(key);
        continue;
      }
      const srcKey = keyOf(op.from, op.lot);
      if (stagedSources.has(srcKey)) throw new DbError('E_ARG', `lot ${op.lot} moved twice in one transaction`);
      stagedSources.add(srcKey);
      // Snapshot validation: batch must still belong to the source pallet,
      // i.e. no transaction committed after our snapshot touched this key.
      const live = db._liveVersion(srcKey);
      if (!live || live.cmin > this.snapshotTs) {
        throw new DbError('E_SNAPSHOT', `lot ${op.lot} no longer belongs to pallet ${op.from}`);
      }
      if (op.from !== op.to) {
        const dstKey = keyOf(op.to, op.lot);
        if (db._liveVersion(dstKey)) throw new DbError('E_DUP', `lot ${op.lot} already exists on pallet ${op.to}`);
        if (stagedTargets.has(dstKey)) throw new DbError('E_DUP', `duplicate staged target lot ${op.lot} on pallet ${op.to}`);
        stagedTargets.add(dstKey);
      }
    }
  }
}

module.exports = { Database, Transaction, DbError, SimulatedCrash };
