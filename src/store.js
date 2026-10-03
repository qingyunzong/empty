import fs from 'node:fs';
import path from 'node:path';
import { Wal, readWal } from './wal.js';
import { emptyState, applyOp } from './state.js';
import { computeCertificate } from './certificate.js';
import { stableStringify, sha256 } from './canon.js';
import { BizError, CorruptionError, SimulatedCrash } from './errors.js';
import { Tx } from './tx.js';

export class Store {
  static open(dir) {
    const store = new Store(dir);
    store._recover();
    return store;
  }

  constructor(dir) {
    this.dir = dir;
    this.statePath = path.join(dir, 'state.json');
    this.walPath = path.join(dir, 'wal.log');
    this.certDir = path.join(dir, 'certificates');
    fs.mkdirSync(this.certDir, { recursive: true });
    this.state = emptyState();
    this.lastCert = null;
    this.activeTx = null;
    this.wal = null;
  }

  _recover() {
    if (fs.existsSync(this.statePath)) {
      let file;
      try {
        file = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      } catch {
        throw new CorruptionError('state snapshot is not valid JSON');
      }
      const { sum, payload } = file ?? {};
      if (!payload || typeof sum !== 'string' || sum !== sha256(stableStringify(payload))) {
        throw new CorruptionError('state snapshot checksum mismatch');
      }
      this.state = payload;
    }

    const { records, tornOffset } = readWal(this.walPath);
    if (tornOffset !== null) fs.truncateSync(this.walPath, tornOffset);

    let pending = [];
    let committedAny = false;
    for (const rec of records) {
      if (rec.type === 'op') {
        pending.push(rec.data);
      } else if (rec.type === 'commit') {
        for (const op of pending) applyOp(this.state, op);
        pending = [];
        this.state.seq += 1;
        this._issueCertificate();
        committedAny = true;
      } else if (rec.type !== 'begin') {
        throw new CorruptionError(`wal: unknown record type ${rec.type}`);
      }
    }
    // Any ops without a commit marker are tentative: discard them.
    if (records.length > 0 || tornOffset !== null) {
      if (committedAny) this._persistState();
      fs.writeFileSync(this.walPath, '');
    }

    this.lastCert = this._readLatestCert();
    this.wal = new Wal(this.walPath);
  }

  _persistState() {
    const payload = this.state;
    const file = JSON.stringify({ payload, sum: sha256(stableStringify(payload)) });
    const tmp = this.statePath + '.tmp';
    fs.writeFileSync(tmp, file);
    fs.renameSync(tmp, this.statePath);
  }

  _issueCertificate() {
    const cert = computeCertificate(this.state, this.state.prevHash);
    this.state.prevHash = cert.hash;
    this.lastCert = cert;
    fs.writeFileSync(path.join(this.certDir, `${String(cert.seq).padStart(8, '0')}.json`),
      JSON.stringify(cert, null, 2));
  }

  _readLatestCert() {
    const files = fs.readdirSync(this.certDir).filter((f) => f.endsWith('.json')).sort();
    if (files.length === 0) return null;
    try {
      return JSON.parse(fs.readFileSync(path.join(this.certDir, files[files.length - 1]), 'utf8'));
    } catch {
      throw new CorruptionError('latest certificate is unreadable');
    }
  }

  begin() {
    if (this.activeTx && !this.activeTx.done) throw new BizError('a top-level transaction is already active');
    this.activeTx = new Tx(this);
    return this.activeTx;
  }

  _commit(tx, opts = {}) {
    this.wal.append({ type: 'commit', tx: tx.id });
    this.wal.fsync();
    if (opts.crash === 'afterMarker') {
      throw new SimulatedCrash('simulated crash after commit marker');
    }
    this.state = tx.state;
    this.state.seq += 1;
    this._issueCertificate();
    this._persistState();
    this.wal.truncate();
    this.wal.fsync();
    return this.lastCert;
  }

  latestCertificate() { return this.lastCert; }

  close() { if (this.wal) this.wal.close(); }
}
