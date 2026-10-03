import fs from 'node:fs';
import path from 'node:path';
import { LockManager } from './lockmanager.js';
import { DbError, E_INSUFFICIENT, E_INVALID, E_NOT_FOUND } from './errors.js';

export const DEFAULT_BALANCE = 1000;

// Offline multi-account quota freeze database.
// - MVCC snapshots for reads; freeze validation uses the latest committed state.
// - Per-account locks via LockManager (deadlock + timeout handling).
// - WAL with PREPARE/COMMIT; recovery ignores any PREPARE without COMMIT.
// - Secondary index over active freezes ordered by (priority, account).
export class Database {
  constructor({ lockTimeoutMs = 200, dir = null } = {}) {
    this.dir = dir;
    this.lockManager = new LockManager({ timeoutMs: lockTimeoutMs });
    this.accounts = new Map(); // name -> { balance, frozen }
    this.versions = new Map(); // name -> [{ version, balance, frozen }] ascending
    this.globalVersion = 0;
    this.txidCounter = 0;
    this.freezeCounter = 0;
    this.walSeq = 0;
    this.appliedSeq = 0;
    this.freezes = new Map(); // id -> { id, account, amount, priority, active }
    this.index = []; // active freezes sorted by (priority, account, id)
    if (dir) this._recover();
  }

  // ---- account helpers ----

  setAccount(name, balance = DEFAULT_BALANCE) {
    if (this.accounts.has(name)) throw new DbError(E_INVALID, `account ${name} already exists`);
    const rec = { balance, frozen: 0 };
    this.accounts.set(name, rec);
    this.versions.set(name, [{ version: this.globalVersion, ...rec }]);
    return rec;
  }

  _ensureAccount(name) {
    if (!this.accounts.has(name)) this.setAccount(name, DEFAULT_BALANCE);
    return this.accounts.get(name);
  }

  _latest(name) {
    const list = this.versions.get(name);
    if (!list || list.length === 0) return null;
    return list[list.length - 1];
  }

  _versionAt(name, version) {
    const list = this.versions.get(name);
    if (!list || list.length === 0) return null;
    let result = list[0];
    for (const entry of list) {
      if (entry.version <= version) result = entry;
      else break;
    }
    return result;
  }

  getAccount(name) {
    const rec = this.accounts.get(name);
    if (!rec) return null;
    return { account: name, balance: rec.balance, frozen: rec.frozen, available: rec.balance - rec.frozen };
  }

  listAccounts() {
    return [...this.accounts.keys()].sort().map((name) => this.getAccount(name));
  }

  scanByPriority() {
    return this.index.map((f) => ({ ...f }));
  }

  // ---- transactions ----

  async transaction(fn) {
    const txid = ++this.txidCounter;
    const tx = new Transaction(this, txid);
    try {
      const result = await fn(tx);
      this._commit(tx);
      return result;
    } catch (err) {
      this.lockManager.releaseAll(txid);
      throw err;
    }
  }

  _commit(tx) {
    if (tx.pendingFreezes.length === 0 && tx.pendingCancels.length === 0) {
      this.lockManager.releaseAll(tx.id);
      return;
    }
    const record = {
      seq: ++this.walSeq,
      type: 'PREPARE',
      txid: tx.id,
      freezes: tx.pendingFreezes.map((f) => ({ ...f })),
      cancels: tx.pendingCancels.map((f) => f.id),
    };
    this._walAppend(record);
    this._apply(record);
    this._walAppend({ seq: ++this.walSeq, type: 'COMMIT', txid: tx.id });
    this.appliedSeq = this.walSeq;
    this._writeSnapshot();
    this.lockManager.releaseAll(tx.id);
  }

  _apply(record) {
    const touched = new Set();
    for (const f of record.freezes) {
      const rec = this._ensureAccount(f.account);
      rec.frozen += f.amount;
      const freeze = { id: f.id, account: f.account, amount: f.amount, priority: f.priority, active: true };
      this.freezes.set(f.id, freeze);
      this._indexInsert(freeze);
      touched.add(f.account);
    }
    for (const id of record.cancels) {
      const freeze = this.freezes.get(id);
      if (!freeze || !freeze.active) continue;
      freeze.active = false;
      const rec = this.accounts.get(freeze.account);
      rec.frozen -= freeze.amount;
      this._indexRemove(freeze);
      touched.add(freeze.account);
    }
    this.globalVersion += 1;
    for (const name of touched) {
      const rec = this.accounts.get(name);
      this.versions.get(name).push({ version: this.globalVersion, balance: rec.balance, frozen: rec.frozen });
    }
  }

  // Used by `crash --prepared`: validate + write PREPARE, then stop.
  // No apply, no COMMIT, no snapshot — the caller exits the process.
  async prepareFreezeThenCrash(account, amount, priority = 0) {
    const txid = ++this.txidCounter;
    const tx = new Transaction(this, txid);
    const freezeId = await tx.freeze(account, amount, priority);
    const record = {
      seq: ++this.walSeq,
      type: 'PREPARE',
      txid,
      freezes: tx.pendingFreezes.map((f) => ({ ...f })),
      cancels: [],
    };
    this._walAppend(record);
    return { txid, freezeId };
  }

  // ---- secondary index (priority, account) ----

  _compare(a, b) {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.account !== b.account) return a.account < b.account ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }

  _indexInsert(freeze) {
    let lo = 0;
    let hi = this.index.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this._compare(this.index[mid], freeze) < 0) lo = mid + 1;
      else hi = mid;
    }
    this.index.splice(lo, 0, freeze);
  }

  _indexRemove(freeze) {
    const idx = this.index.indexOf(freeze);
    if (idx >= 0) this.index.splice(idx, 1);
  }

  // ---- persistence: snapshot + WAL ----

  get _walPath() { return path.join(this.dir, 'wal.log'); }
  get _snapshotPath() { return path.join(this.dir, 'data.json'); }

  _walAppend(record) {
    if (!this.dir) return;
    fs.mkdirSync(this.dir, { recursive: true });
    const fd = fs.openSync(this._walPath, 'a');
    try {
      fs.writeSync(fd, JSON.stringify(record) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  _writeSnapshot() {
    if (!this.dir) return;
    fs.mkdirSync(this.dir, { recursive: true });
    const snapshot = {
      appliedSeq: this.appliedSeq,
      txidCounter: this.txidCounter,
      freezeCounter: this.freezeCounter,
      globalVersion: this.globalVersion,
      accounts: Object.fromEntries(this.accounts),
      freezes: [...this.freezes.values()],
    };
    const tmp = this._snapshotPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
    fs.renameSync(tmp, this._snapshotPath);
  }

  _recover() {
    fs.mkdirSync(this.dir, { recursive: true });
    if (fs.existsSync(this._snapshotPath)) {
      const snap = JSON.parse(fs.readFileSync(this._snapshotPath, 'utf8'));
      this.appliedSeq = snap.appliedSeq;
      this.txidCounter = snap.txidCounter;
      this.freezeCounter = snap.freezeCounter;
      this.globalVersion = snap.globalVersion;
      for (const [name, rec] of Object.entries(snap.accounts)) {
        this.accounts.set(name, { ...rec });
        this.versions.set(name, [{ version: this.globalVersion, balance: rec.balance, frozen: rec.frozen }]);
      }
      for (const f of snap.freezes) {
        this.freezes.set(f.id, { ...f });
        if (f.active) this._indexInsert(this.freezes.get(f.id));
      }
    }
    if (fs.existsSync(this._walPath)) {
      const prepared = new Map();
      const committed = new Set();
      for (const line of fs.readFileSync(this._walPath, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        const rec = JSON.parse(line);
        this.walSeq = Math.max(this.walSeq, rec.seq);
        if (rec.seq <= this.appliedSeq) continue;
        if (rec.type === 'PREPARE') prepared.set(rec.txid, rec);
        else if (rec.type === 'COMMIT') committed.add(rec.txid);
      }
      for (const [txid, rec] of prepared) {
        if (committed.has(txid)) this._apply(rec);
        // PREPARE without COMMIT: freeze never takes effect (crash recovery)
      }
      if (committed.size > 0) {
        this.appliedSeq = this.walSeq;
        this._writeSnapshot();
      }
    }
    // Lock table is in-memory only: it is empty after any restart/crash.
  }
}

export class Transaction {
  constructor(db, id) {
    this.db = db;
    this.id = id;
    this.snapshotVersion = db.globalVersion;
    this.pendingFreezes = [];
    this.pendingCancels = [];
  }

  async freeze(account, amount, priority = 0) {
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new DbError(E_INVALID, `invalid freeze amount: ${amount}`);
    }
    const db = this.db;
    db._ensureAccount(account);
    await db.lockManager.acquire(this.id, account);
    const latest = db._latest(account);
    const pending = this._pendingDelta(account);
    const available = latest.balance - latest.frozen - pending;
    if (amount > available) {
      throw new DbError(E_INSUFFICIENT, `insufficient available quota on ${account}: need ${amount}, have ${available}`);
    }
    const id = `F${++db.freezeCounter}`;
    this.pendingFreezes.push({ id, account, amount, priority });
    return id;
  }

  async cancel(freezeId) {
    const db = this.db;
    const freeze = db.freezes.get(freezeId);
    if (!freeze || !freeze.active) throw new DbError(E_NOT_FOUND, `freeze ${freezeId} not found or inactive`);
    if (this.pendingCancels.includes(freeze)) throw new DbError(E_INVALID, `freeze ${freezeId} already cancelled in this transaction`);
    await db.lockManager.acquire(this.id, freeze.account);
    this.pendingCancels.push(freeze);
  }

  _pendingDelta(account) {
    let delta = 0;
    for (const f of this.pendingFreezes) if (f.account === account) delta += f.amount;
    for (const f of this.pendingCancels) if (f.account === account) delta -= f.amount;
    return delta;
  }

  // MVCC snapshot read: sees state as of transaction begin.
  getAvailable(account) {
    const v = this.db._versionAt(account, this.snapshotVersion);
    if (!v) return null;
    return v.balance - v.frozen;
  }

  // Latest committed read (used for freeze validation).
  getLatestAvailable(account) {
    const v = this.db._latest(account);
    if (!v) return null;
    return v.balance - v.frozen;
  }
}
