'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Offline settlement ledger with MVCC, WAL, checkpoints and crash recovery.
//
// On-disk layout inside the data directory:
//   wal.log              append-only JSON-lines write-ahead log
//   checkpoint.json      committed table + secondary index + version watermark,
//                        plus the version chains retained after GC
//   checkpoint.json.tmp  staging file; only becomes valid via atomic rename
//   snapshots/<id>.json  active snapshot watermarks (survive restarts)
class Ledger {
  constructor(dir) {
    this.dir = dir;
    this.walPath = path.join(dir, 'wal.log');
    this.checkpointPath = path.join(dir, 'checkpoint.json');
    this.checkpointTmpPath = path.join(dir, 'checkpoint.json.tmp');
    this.snapshotDir = path.join(dir, 'snapshots');

    this.version = 0; // high-water version == last applied LSN
    this.walLsn = 0; // LSN up to which the loaded checkpoint covers the WAL
    this.committed = new Map(); // account -> latest committed balance
    this.index = new Map(); // txId -> {tx, account, amount, status, version, cancelVersion?}
    this.versions = new Map(); // account -> [{version, balance, tx, op}] ascending

    this._recover();
  }

  _recover() {
    fs.mkdirSync(this.snapshotDir, { recursive: true });

    // A leftover tmp file is the residue of a checkpoint interrupted at C1
    // (partial write) or C2 (complete write, no rename). It is never trusted:
    // only an atomically renamed checkpoint.json is valid.
    fs.rmSync(this.checkpointTmpPath, { force: true });

    if (fs.existsSync(this.checkpointPath)) {
      const cp = JSON.parse(fs.readFileSync(this.checkpointPath, 'utf8'));
      this.version = cp.watermark;
      this.walLsn = cp.walLsn;
      this.committed = new Map(Object.entries(cp.committed));
      this.index = new Map(Object.entries(cp.index));
      this.versions = new Map(Object.entries(cp.versions));
    }

    if (fs.existsSync(this.walPath)) {
      const lines = fs.readFileSync(this.walPath, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line === '') continue;
        let rec;
        try {
          rec = JSON.parse(line);
        } catch (err) {
          // Tolerate a torn tail write from a crash during WAL append.
          if (i === lines.length - 1) break;
          throw err;
        }
        if (rec.lsn > this.walLsn) this._apply(rec);
      }
    }
  }

  _appendWal(rec) {
    const fd = fs.openSync(this.walPath, 'a');
    try {
      fs.writeSync(fd, JSON.stringify(rec) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  _apply(rec) {
    this.version = rec.lsn;
    if (rec.op === 'pay') {
      const balance = (this.committed.get(rec.account) ?? 0) + rec.amount;
      this.committed.set(rec.account, balance);
      this._pushVersion(rec.account, { version: rec.lsn, balance, tx: rec.tx, op: 'pay' });
      this.index.set(rec.tx, {
        tx: rec.tx,
        account: rec.account,
        amount: rec.amount,
        status: 'paid',
        version: rec.lsn,
      });
    } else if (rec.op === 'cancel') {
      const orig = this.index.get(rec.tx);
      if (!orig) throw new Error(`unknown tx: ${rec.tx}`);
      // Reversal version: undo the original payment on the same account.
      const balance = (this.committed.get(rec.account) ?? 0) - rec.amount;
      this.committed.set(rec.account, balance);
      this._pushVersion(rec.account, { version: rec.lsn, balance, tx: rec.tx, op: 'reversal' });
      orig.status = 'cancelled';
      orig.cancelVersion = rec.lsn;
    } else {
      throw new Error(`unknown op: ${rec.op}`);
    }
  }

  _pushVersion(account, entry) {
    let chain = this.versions.get(account);
    if (!chain) {
      chain = [];
      this.versions.set(account, chain);
    }
    chain.push(entry);
  }

  pay(tx, account, amount) {
    if (this.index.has(tx)) throw new Error(`duplicate tx: ${tx}`);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error(`amount must be a positive number, got: ${amount}`);
    }
    const rec = { lsn: this.version + 1, op: 'pay', tx, account, amount };
    this._appendWal(rec);
    this._apply(rec);
    return rec.lsn;
  }

  cancel(tx) {
    const orig = this.index.get(tx);
    if (!orig) throw new Error(`unknown tx: ${tx}`);
    if (orig.status !== 'paid') throw new Error(`tx is not paid: ${tx}`);
    const rec = { lsn: this.version + 1, op: 'cancel', tx, account: orig.account, amount: orig.amount };
    this._appendWal(rec);
    this._apply(rec);
    return rec.lsn;
  }

  beginSnapshot() {
    const id = `snap-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const snap = { id, watermark: this.version };
    fs.writeFileSync(path.join(this.snapshotDir, `${id}.json`), JSON.stringify(snap));
    return id;
  }

  endSnapshot(id) {
    fs.rmSync(path.join(this.snapshotDir, `${id}.json`), { force: true });
  }

  activeSnapshots() {
    return fs
      .readdirSync(this.snapshotDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(this.snapshotDir, f), 'utf8')));
  }

  // Version GC: a version may only be dropped if no active snapshot can still
  // observe it. For every account we keep every version newer than the oldest
  // active snapshot watermark, plus the newest version at or below it (the one
  // that snapshot reads). With no active snapshots only the latest survives.
  gc() {
    const snaps = this.activeSnapshots();
    const floor = snaps.length ? Math.min(...snaps.map((s) => s.watermark)) : Infinity;
    for (const [account, chain] of this.versions) {
      let kept;
      if (floor === Infinity) {
        kept = [chain[chain.length - 1]];
      } else {
        kept = chain.filter((v) => v.version > floor);
        let base = null;
        for (const v of chain) {
          if (v.version <= floor) base = v;
        }
        if (base) kept.unshift(base);
      }
      this.versions.set(account, kept);
    }
    return floor;
  }

  _state() {
    return {
      watermark: this.version,
      walLsn: this.version,
      committed: Object.fromEntries(this.committed),
      index: Object.fromEntries(this.index),
      versions: Object.fromEntries(this.versions),
    };
  }

  // Checkpoint V: GC versions, then persist committed table + secondary index
  // + version watermark via tmp file, fsync and atomic rename.
  checkpoint() {
    this.gc();
    const data = JSON.stringify(this._state());
    const fd = fs.openSync(this.checkpointTmpPath, 'w');
    try {
      fs.writeSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(this.checkpointTmpPath, this.checkpointPath);
    const dfd = fs.openSync(this.dir, 'r');
    try {
      fs.fsyncSync(dfd);
    } finally {
      fs.closeSync(dfd);
    }
    this.walLsn = this.version;
    return this.version;
  }

  // Simulate a crash mid-checkpoint. C1: dies before the tmp file is fully
  // written. C2: dies after a complete, fsynced tmp file but before rename.
  // The caller is expected to die abruptly right after this returns.
  crashCheckpoint(point) {
    const data = JSON.stringify(this._state());
    const fd = fs.openSync(this.checkpointTmpPath, 'w');
    try {
      if (point === 'C1') {
        fs.writeSync(fd, data.slice(0, Math.max(1, Math.floor(data.length / 2))));
      } else if (point === 'C2') {
        fs.writeSync(fd, data);
        fs.fsyncSync(fd);
      } else {
        throw new Error(`unknown crash point: ${point}`);
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  getAt(account, at) {
    const chain = this.versions.get(account);
    if (!chain) return 0;
    let balance = 0;
    for (const v of chain) {
      if (v.version <= at) balance = v.balance;
      else break;
    }
    return balance;
  }

  resolveAt(at) {
    if (typeof at === 'number') return at;
    if (/^\d+$/.test(at)) return Number(at);
    const p = path.join(this.snapshotDir, `${at}.json`);
    if (!fs.existsSync(p)) throw new Error(`unknown snapshot: ${at}`);
    return JSON.parse(fs.readFileSync(p, 'utf8')).watermark;
  }

  dump() {
    return {
      watermark: this.version,
      walLsn: this.walLsn,
      committed: Object.fromEntries(this.committed),
      index: Object.fromEntries(this.index),
      versions: Object.fromEntries(this.versions),
      snapshots: this.activeSnapshots(),
    };
  }
}

module.exports = { Ledger };
