import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class DBError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DBError';
    this.code = code;
  }
}

// Deterministic byte-level serialization of a snapshot: keys sorted, one
// "json(key)=json(value)" pair per line. All published reads and certificate
// hashes are derived from this canonical form, so results are byte-identical
// to what was observed at publish time.
export function canonicalize(state) {
  const keys = [...state.keys()].sort();
  if (keys.length === 0) return '';
  return keys.map((k) => `${JSON.stringify(k)}=${JSON.stringify(state.get(k))}`).join('\n') + '\n';
}

export function certHash(state) {
  return crypto.createHash('sha256').update(canonicalize(state), 'utf8').digest('hex');
}

// Crash-injection hook for tests: DCDB_CRASH_AT=before-cert|before-wal
// simulates a power failure (immediate exit, no cleanup).
function crashPoint(name) {
  if (process.env.DCDB_CRASH_AT === name) process.exit(137);
}

function writeFileAtomic(file, data) {
  const tmp = `${file}.tmp.${process.pid}`;
  const fd = fs.openSync(tmp, 'w');
  fs.writeSync(fd, data);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmp, file);
}

export class DCDB {
  static open(dir) {
    const db = new DCDB(dir);
    db._load();
    return db;
  }

  constructor(dir) {
    this.dir = dir;
    this.walFile = path.join(dir, 'wal.log');
    this.certDir = path.join(dir, 'certs');
    this.currentVersion = 0;
    this.state = new Map(); // committed state at currentVersion
    this.commits = []; // [{version, writes}] in order, for historical replay
    this.published = new Map(); // cert -> {version, cert, snapshot}
    this.versionToCert = new Map(); // version -> cert
    this.frozenKeys = new Set(); // union of keys in every published snapshot
  }

  _load() {
    fs.mkdirSync(this.certDir, { recursive: true });

    const events = [];
    if (fs.existsSync(this.walFile)) {
      const raw = fs.readFileSync(this.walFile, 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          events.push(JSON.parse(line));
        } catch {
          break; // torn tail from a crash: ignore the rest
        }
      }
    }

    for (const ev of events) {
      if (ev.type !== 'commit') continue;
      this.currentVersion = ev.version;
      for (const [k, v] of Object.entries(ev.writes)) this.state.set(k, v);
      this.commits.push({ version: ev.version, writes: ev.writes });
    }

    const certsOnDisk = new Map();
    for (const f of fs.readdirSync(this.certDir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const cert = JSON.parse(fs.readFileSync(path.join(this.certDir, f), 'utf8'));
        certsOnDisk.set(cert.cert, cert);
      } catch {
        // ignore unreadable cert files
      }
    }

    // A publish only takes effect if its certificate actually landed on disk.
    // A WAL publish record without a cert file (crash mid-publish) is dropped,
    // so the version stays a draft and can be re-published.
    for (const ev of events) {
      if (ev.type !== 'publish') continue;
      const cert = certsOnDisk.get(ev.cert);
      if (cert) this._registerPublish(cert);
    }
  }

  _registerPublish(cert) {
    this.published.set(cert.cert, cert);
    this.versionToCert.set(cert.version, cert.cert);
    for (const k of Object.keys(cert.snapshot)) this.frozenKeys.add(k);
  }

  _appendWal(ev) {
    const fd = fs.openSync(this.walFile, 'a');
    fs.writeSync(fd, JSON.stringify(ev) + '\n');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
  }

  stateAt(version) {
    if (!Number.isInteger(version) || version < 1 || version > this.currentVersion) {
      throw new DBError('NO_VERSION', `version ${version} does not exist`);
    }
    const s = new Map();
    for (const c of this.commits) {
      if (c.version > version) break;
      for (const [k, v] of Object.entries(c.writes)) s.set(k, v);
    }
    return s;
  }

  begin() {
    return new Txn(this);
  }

  _commit(writes) {
    for (const k of Object.keys(writes)) {
      if (this.frozenKeys.has(k)) {
        throw new DBError('FROZEN', `key ${JSON.stringify(k)} belongs to a published version and is frozen`);
      }
    }
    const version = this.currentVersion + 1;
    this._appendWal({ type: 'commit', version, writes });
    this.currentVersion = version;
    for (const [k, v] of Object.entries(writes)) this.state.set(k, v);
    this.commits.push({ version, writes });
    return version;
  }

  publish(version) {
    if (!Number.isInteger(version) || version < 1 || version > this.currentVersion) {
      throw new DBError('NO_VERSION', `version ${version} does not exist`);
    }
    const existing = this.versionToCert.get(version);
    if (existing) return this.published.get(existing); // idempotent

    const state = this.stateAt(version);
    const cert = certHash(state);
    const snapshot = {};
    for (const k of [...state.keys()].sort()) snapshot[k] = state.get(k);
    const record = { version, cert, snapshot };

    crashPoint('before-cert');
    writeFileAtomic(path.join(this.certDir, `${cert}.json`), JSON.stringify(record, null, 2) + '\n');
    crashPoint('before-wal');
    this._appendWal({ type: 'publish', version, cert });
    this._registerPublish(record);
    return record;
  }

  get({ version, cert } = {}) {
    if (cert !== undefined) {
      const rec = this.published.get(cert);
      if (!rec) throw new DBError('NO_VERSION', `no published version for cert ${cert}`);
      return new Map(Object.entries(rec.snapshot));
    }
    if (version !== undefined) {
      const c = this.versionToCert.get(version);
      if (c) return new Map(Object.entries(this.published.get(c).snapshot));
      return this.stateAt(version);
    }
    return new Map(this.state);
  }

  verify({ version, cert } = {}) {
    let hash = cert;
    if (hash === undefined) {
      if (version !== undefined) hash = this.versionToCert.get(version);
      if (hash === undefined) throw new DBError('NO_VERSION', 'no published version to verify');
    }
    const file = path.join(this.certDir, `${hash}.json`);
    if (!fs.existsSync(file)) throw new DBError('NO_VERSION', `no certificate ${hash}`);
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    const recomputed = certHash(new Map(Object.entries(rec.snapshot)));
    if (rec.cert !== hash || recomputed !== hash) {
      throw new DBError('TAMPER', `certificate mismatch: expected ${hash}, file declares ${rec.cert}, recomputed ${recomputed}`);
    }
    return true;
  }
}

class Txn {
  constructor(db) {
    this.db = db;
    this.baseVersion = db.currentVersion;
    this.writes = {};
  }

  put(key, value) {
    if (typeof key !== 'string' || typeof value !== 'string') {
      throw new DBError('BAD_VALUE', 'keys and values must be strings');
    }
    this.writes[key] = value;
  }

  get(key) {
    if (Object.hasOwn(this.writes, key)) return this.writes[key];
    return this.db.state.get(key);
  }

  commit() {
    return this.db._commit(this.writes);
  }
}
