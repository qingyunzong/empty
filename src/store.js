import fs from 'node:fs';
import path from 'node:path';
import { StoreError } from './errors.js';
import { WalWriter, scanWal } from './wal.js';

const WAL_NAME = 'wal.log';
const SEP = '\0';
const ikey = (pallet, lot) => `${pallet}${SEP}${lot}`;

function checkName(kind, value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes(SEP) || value.includes('\n')) {
    throw new StoreError('E_INVAL', `invalid ${kind}: ${JSON.stringify(value)}`);
  }
}

export class Store {
  static init(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const wal = path.join(dir, WAL_NAME);
    if (fs.existsSync(wal)) throw new StoreError('E_INVAL', `store already initialized at ${dir}`);
    fs.writeFileSync(wal, '');
    return Store.open(dir);
  }

  static open(dir) {
    const wal = path.join(dir, WAL_NAME);
    if (!fs.existsSync(wal)) throw new StoreError('E_NOT_FOUND', `no store at ${dir} (run init first)`);
    const store = new Store(dir);
    store._recover();
    return store;
  }

  constructor(dir) {
    this.dir = dir;
    this.walPath = path.join(dir, WAL_NAME);
    this.txid = 0;
    this.lots = new Map(); // uid -> version chain [{tx, pallet, lot, quarantine}], newest last
    this.index = new Map(); // (palletId, lotId) -> uid  (unique secondary index)
    this.uidSeq = 0;
    this.poisoned = false;
    this.wal = null;
  }

  _recover() {
    const { entries, committedBytes, totalBytes } = scanWal(this.walPath);
    let pending = null;
    for (const e of entries) {
      switch (e.t) {
        case 'begin':
          pending = { tx: e.tx, records: [] }; // discards any uncommitted leftover
          break;
        case 'put':
        case 'xfer':
          if (!pending || pending.tx !== e.tx) {
            throw new StoreError('E_CORRUPT', 'wal record outside transaction');
          }
          pending.records.push(e);
          break;
        case 'commit':
          if (!pending || pending.tx !== e.tx) {
            throw new StoreError('E_CORRUPT', 'wal commit without transaction');
          }
          if (e.tx <= this.txid) throw new StoreError('E_CORRUPT', 'non-monotonic txid in wal');
          this._applyCommitted(e.tx, pending.records);
          pending = null;
          break;
        default:
          throw new StoreError('E_CORRUPT', `unknown wal entry type ${JSON.stringify(e.t)}`);
      }
    }
    // A leftover pending block is a crashed tentative transfer: roll it back by
    // truncating the WAL to the last commit marker; state and index are rebuilt.
    if (committedBytes < totalBytes) fs.truncateSync(this.walPath, committedBytes);
    this.wal = new WalWriter(this.walPath);
  }

  _applyCommitted(tx, records) {
    for (const r of records) {
      if (r.t === 'put') {
        const k = ikey(r.pallet, r.lot);
        if (this.lots.has(r.uid)) throw new StoreError('E_CORRUPT', `duplicate uid ${r.uid} in wal`);
        if (this.index.has(k)) throw new StoreError('E_CORRUPT', `index conflict on replay at (${r.pallet}, ${r.lot})`);
        this.lots.set(r.uid, [{ tx, pallet: r.pallet, lot: r.lot, quarantine: !!r.quarantine }]);
        this.index.set(k, r.uid);
        const n = Number(r.uid.slice(1));
        if (Number.isInteger(n) && n >= this.uidSeq) this.uidSeq = n + 1;
      } else {
        const chain = this.lots.get(r.uid);
        if (!chain) throw new StoreError('E_CORRUPT', `xfer of unknown batch ${r.uid}`);
        const cur = chain[chain.length - 1];
        if (cur.pallet !== r.from || cur.lot !== r.lot) {
          throw new StoreError('E_CORRUPT', `xfer source mismatch for ${r.uid}`);
        }
        const to = ikey(r.to, r.lot);
        if (this.index.has(to)) throw new StoreError('E_CORRUPT', `index conflict on replay at (${r.to}, ${r.lot})`);
        this.index.delete(ikey(r.from, r.lot));
        chain.push({ tx, pallet: r.to, lot: r.lot, quarantine: !!r.quarantine });
        this.index.set(to, r.uid);
      }
    }
    this.txid = tx;
  }

  _assertUsable() {
    if (this.poisoned) {
      throw new StoreError('E_CRASH', 'store instance died after simulated crash; reopen it');
    }
  }

  _current(uid) {
    const chain = this.lots.get(uid);
    return chain[chain.length - 1];
  }

  // Resolve which batch (uid) visibly sits at (pallet, lot) as of `snapshot`.
  _resolveAt(snapshot, pallet, lot) {
    for (const [uid, chain] of this.lots) {
      for (let i = chain.length - 1; i >= 0; i--) {
        if (chain[i].tx <= snapshot) {
          if (chain[i].pallet === pallet && chain[i].lot === lot) return uid;
          break;
        }
      }
    }
    return null;
  }

  _crash() {
    this.poisoned = true;
    try {
      this.wal.close();
    } catch {
      // process is "dead" anyway
    }
    throw new StoreError('E_CRASH', 'simulated crash');
  }

  begin() {
    this._assertUsable();
    return new Tx(this, this.txid);
  }

  put(pallet, lot, opts = {}) {
    const tx = this.begin();
    tx.put(pallet, lot, opts);
    return tx.commit(opts);
  }

  transfer(from, to, lots, opts = {}) {
    const tx = this.begin();
    tx.transfer(from, to, lots, opts);
    return tx.commit(opts);
  }

  dump() {
    this._assertUsable();
    const pallets = {};
    const index = [];
    for (const [k, uid] of this.index) {
      const [pallet, lot] = k.split(SEP);
      const v = this._current(uid);
      (pallets[pallet] ??= []).push({ lot, quarantine: v.quarantine, uid });
      index.push({ pallet, lot, uid });
    }
    for (const list of Object.values(pallets)) list.sort((a, b) => (a.lot < b.lot ? -1 : 1));
    index.sort((a, b) => (a.pallet + SEP + a.lot < b.pallet + SEP + b.lot ? -1 : 1));
    return { txid: this.txid, pallets, index };
  }
}

export class Tx {
  constructor(store, snapshot) {
    this.store = store;
    this.snapshot = snapshot;
    this.ops = [];
    this.done = false;
  }

  _assertOpen() {
    this.store._assertUsable();
    if (this.done) throw new StoreError('E_INVAL', 'transaction already finished');
  }

  put(pallet, lot, { quarantine = false } = {}) {
    this._assertOpen();
    checkName('pallet', pallet);
    checkName('lot', lot);
    if (
      this.store._resolveAt(this.snapshot, pallet, lot) !== null ||
      this.store.index.has(ikey(pallet, lot))
    ) {
      throw new StoreError('E_DUP', `pallet ${pallet} already holds lot ${lot}`);
    }
    this.ops.push({ t: 'put', pallet, lot, quarantine: !!quarantine });
  }

  transfer(from, to, lots, { quarantine = false } = {}) {
    this._assertOpen();
    checkName('from', from);
    checkName('to', to);
    if (!Array.isArray(lots) || lots.length === 0) {
      throw new StoreError('E_INVAL', 'lots must be a non-empty array');
    }
    if (new Set(lots).size !== lots.length) {
      throw new StoreError('E_INVAL', 'duplicate lot in transfer request');
    }
    for (const lot of lots) {
      checkName('lot', lot);
      const uid = this.store._resolveAt(this.snapshot, from, lot);
      if (uid === null) throw new StoreError('E_NOT_FOUND', `lot ${lot} not on pallet ${from}`);
      const occupant = this.store._resolveAt(this.snapshot, to, lot);
      if (occupant !== null && occupant !== uid) {
        throw new StoreError('E_DUP', `pallet ${to} already holds lot ${lot}`);
      }
      this.ops.push({ t: 'xfer', uid, from, to, lot, quarantine: !!quarantine });
    }
  }

  commit({ crashPoint = null } = {}) {
    this._assertOpen();
    this.done = true;
    const s = this.store;
    // Commit-time validation against current committed state: snapshot
    // freshness, source ownership and target uniqueness.
    for (const op of this.ops) {
      if (op.t === 'xfer') {
        const cur = s._current(op.uid);
        if (cur.tx > this.snapshot) {
          throw new StoreError('E_SNAPSHOT', `lot ${op.lot} changed after snapshot ${this.snapshot}`);
        }
        if (cur.pallet !== op.from) {
          throw new StoreError('E_SNAPSHOT', `lot ${op.lot} no longer belongs to ${op.from}`);
        }
        const occupant = s.index.get(ikey(op.to, op.lot));
        if (occupant !== undefined && occupant !== op.uid) {
          throw new StoreError('E_DUP', `pallet ${op.to} already holds lot ${op.lot}`);
        }
      } else if (s.index.has(ikey(op.pallet, op.lot))) {
        throw new StoreError('E_DUP', `pallet ${op.pallet} already holds lot ${op.lot}`);
      }
    }
    const tx = s.txid + 1;
    const records = this.ops.map((op) =>
      op.t === 'put'
        ? { t: 'put', tx, uid: `b${s.uidSeq++}`, pallet: op.pallet, lot: op.lot, quarantine: op.quarantine }
        : { t: 'xfer', tx, uid: op.uid, from: op.from, to: op.to, lot: op.lot, quarantine: op.quarantine },
    );
    s.wal.append({ t: 'begin', tx });
    for (const r of records) s.wal.append(r);
    s.wal.sync();
    if (crashPoint === 'after_records') s._crash();
    s.wal.append({ t: 'commit', tx });
    s.wal.sync();
    if (crashPoint === 'after_commit') s._crash();
    s._applyCommitted(tx, records);
    return { txid: tx };
  }

  rollback() {
    this.done = true;
  }
}
