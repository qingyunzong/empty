'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CHECKPOINT_MAGIC = 'settlement-ledger-checkpoint-v1';

class SimulatedCrashError extends Error {
  constructor(point) {
    super(`simulated crash at ${point}`);
    this.name = 'SimulatedCrashError';
    this.point = point;
  }
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

class Ledger {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.walPath = path.join(dir, 'wal.log');
    this.checkpointPath = path.join(dir, 'checkpoint.json');
    this.checkpointTmpPath = path.join(dir, 'checkpoint.json.tmp');
    this.snapshotsPath = path.join(dir, 'snapshots.json');
    this._recover();
  }

  _recover() {
    this.version = 0;
    this.watermark = 0;
    this.accounts = new Map();
    this.txIndex = new Map();

    // A leftover tmp checkpoint is never trusted: it is either a partial
    // write (crash at C1) or a complete file that was never atomically
    // renamed (crash at C2). The old checkpoint plus WAL replay covers it.
    fs.rmSync(this.checkpointTmpPath, { force: true });

    const cp = readJsonFile(this.checkpointPath);
    if (cp && cp.magic === CHECKPOINT_MAGIC && Number.isSafeInteger(cp.watermark)) {
      this.watermark = cp.watermark;
      this.version = cp.watermark;
      for (const [name, a] of Object.entries(cp.accounts)) {
        this.accounts.set(name, {
          balance: a.balance,
          versions: a.versions.map((v) => ({ version: v.version, balance: v.balance })),
        });
      }
      for (const [id, tx] of Object.entries(cp.txIndex)) {
        this.txIndex.set(id, { ...tx });
      }
    }

    if (fs.existsSync(this.walPath)) {
      const lines = fs.readFileSync(this.walPath, 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        const rec = JSON.parse(line);
        if (rec.version <= this.watermark) continue;
        this._apply(rec);
      }
    }

    const snaps = readJsonFile(this.snapshotsPath);
    this.snapshots = Array.isArray(snaps) ? snaps : [];
  }

  _account(name) {
    if (!this.accounts.has(name)) {
      this.accounts.set(name, { balance: 0, versions: [{ version: 0, balance: 0 }] });
    }
    return this.accounts.get(name);
  }

  _pushVersion(acct) {
    acct.versions.push({ version: this.version, balance: acct.balance });
  }

  _apply(rec) {
    if (rec.type === 'pay') {
      const from = this._account(rec.from);
      const to = this._account(rec.to);
      from.balance -= rec.amount;
      to.balance += rec.amount;
      this.version = rec.version;
      this._pushVersion(from);
      this._pushVersion(to);
      this.txIndex.set(rec.txId, {
        txId: rec.txId,
        type: 'pay',
        from: rec.from,
        to: rec.to,
        amount: rec.amount,
        version: rec.version,
        status: 'paid',
        cancelVersion: null,
      });
    } else if (rec.type === 'cancel') {
      const tx = this.txIndex.get(rec.txId);
      if (!tx) throw new Error(`unknown tx ${rec.txId}`);
      if (tx.status !== 'paid') throw new Error(`tx ${rec.txId} is not in paid state`);
      const from = this._account(tx.from);
      const to = this._account(tx.to);
      from.balance += tx.amount;
      to.balance -= tx.amount;
      this.version = rec.version;
      this._pushVersion(from);
      this._pushVersion(to);
      tx.status = 'cancelled';
      tx.cancelVersion = rec.version;
    } else {
      throw new Error(`unknown WAL record type ${rec.type}`);
    }
  }

  _appendWal(rec) {
    fs.appendFileSync(this.walPath, JSON.stringify(rec) + '\n');
  }

  pay({ txId, from, to, amount }) {
    if (!txId || typeof txId !== 'string') throw new Error('txId is required');
    if (this.txIndex.has(txId)) throw new Error(`duplicate txId ${txId}`);
    if (!from || !to) throw new Error('from and to accounts are required');
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new Error('amount must be a positive integer');
    }
    const rec = { version: this.version + 1, type: 'pay', txId, from, to, amount };
    this._appendWal(rec);
    this._apply(rec);
    return rec.version;
  }

  cancel({ txId }) {
    const tx = this.txIndex.get(txId);
    if (!tx) throw new Error(`unknown tx ${txId}`);
    if (tx.status !== 'paid') throw new Error(`tx ${txId} is not in paid state`);
    const rec = { version: this.version + 1, type: 'cancel', txId };
    this._appendWal(rec);
    this._apply(rec);
    return rec.version;
  }

  beginSnapshot(id) {
    const snapId = id || `snap-${this.snapshots.length + 1}`;
    if (this.snapshots.some((s) => s.id === snapId)) {
      throw new Error(`snapshot ${snapId} already exists`);
    }
    const snap = { id: snapId, version: this.version };
    this.snapshots.push(snap);
    this._saveSnapshots();
    return snap;
  }

  endSnapshot(id) {
    const before = this.snapshots.length;
    this.snapshots = this.snapshots.filter((s) => s.id !== id);
    if (this.snapshots.length === before) throw new Error(`unknown snapshot ${id}`);
    this._saveSnapshots();
  }

  _saveSnapshots() {
    fs.writeFileSync(this.snapshotsPath, JSON.stringify(this.snapshots, null, 2));
  }

  balanceAt(name, at) {
    const version = at === undefined || at === null ? this.version : at;
    if (!Number.isSafeInteger(version) || version < 0) {
      throw new Error(`invalid version ${at}`);
    }
    if (version > this.version) {
      throw new Error(`version ${version} is in the future (current ${this.version})`);
    }
    const acct = this.accounts.get(name);
    if (!acct) return 0;
    let result = null;
    for (const v of acct.versions) {
      if (v.version <= version) result = v.balance;
      else break;
    }
    if (result === null) {
      throw new Error(`no retained version of ${name} visible at ${version}`);
    }
    return result;
  }

  getTx(txId) {
    const tx = this.txIndex.get(txId);
    if (!tx) throw new Error(`unknown tx ${txId}`);
    return { ...tx };
  }

  // Keep the version visible to the oldest active snapshot plus everything
  // newer; with no active snapshots only the latest version survives.
  _gcVersions() {
    const floor = this.snapshots.length
      ? Math.min(...this.snapshots.map((s) => s.version))
      : this.version;
    for (const acct of this.accounts.values()) {
      const newer = [];
      let visible = null;
      for (const v of acct.versions) {
        if (v.version <= floor) visible = v;
        else newer.push(v);
      }
      acct.versions = visible ? [visible, ...newer] : newer;
    }
  }

  checkpoint({ crashPoint = null } = {}) {
    this._gcVersions();
    const prev = readJsonFile(this.checkpointPath);
    const seq =
      prev && Number.isSafeInteger(prev.checkpointVersion) ? prev.checkpointVersion + 1 : 1;
    const payload = JSON.stringify(
      {
        magic: CHECKPOINT_MAGIC,
        checkpointVersion: seq,
        watermark: this.version,
        accounts: Object.fromEntries(
          [...this.accounts].map(([name, a]) => [
            name,
            { balance: a.balance, versions: a.versions },
          ]),
        ),
        txIndex: Object.fromEntries(this.txIndex),
      },
      null,
      2,
    );

    if (crashPoint === 'C1') {
      // Die before the tmp file is fully written.
      fs.writeFileSync(this.checkpointTmpPath, payload.slice(0, Math.floor(payload.length / 2)));
      throw new SimulatedCrashError('C1');
    }

    fs.writeFileSync(this.checkpointTmpPath, payload);
    const fd = fs.openSync(this.checkpointTmpPath, 'r+');
    fs.fsyncSync(fd);
    fs.closeSync(fd);

    if (crashPoint === 'C2') {
      // Die after the tmp file is durable but before the atomic rename.
      throw new SimulatedCrashError('C2');
    }

    fs.renameSync(this.checkpointTmpPath, this.checkpointPath);
    return seq;
  }
}

module.exports = { Ledger, SimulatedCrashError, CHECKPOINT_MAGIC };
