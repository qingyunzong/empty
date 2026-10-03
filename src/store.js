import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const FROZEN = 'FROZEN';
export const NO_VERSION = 'NO_VERSION';
export const TAMPER = 'TAMPER';

export class SimulatedCrash extends Error {
  constructor() {
    super('simulated crash (power loss): no cleanup, no flush');
    this.name = 'SimulatedCrash';
    this.code = 'CRASH';
  }
}

export class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

function versionError(version) {
  return new StoreError(NO_VERSION, `version ${version} does not exist`);
}

function tamperError(version) {
  return new StoreError(TAMPER, `content of version ${version} does not match its certificate`);
}

function freezeErrorForKeys(keys) {
  return new StoreError(FROZEN, `write set touches frozen keys: ${keys.join(', ')}`);
}

function snapshotAt(version) {
  if (!Number.isInteger(version) || version < 0 || version > this.commits.length) {
    throw versionError(version);
  }
  if (version === 0) return new Map();
  if (this.snapshotCache.has(version)) return this.snapshotCache.get(version);
  const snap = new Map();
  for (let i = 0; i < version; i++) {
    for (const [k, v] of Object.entries(this.commits[i].writes)) snap.set(k, v);
  }
  if (this.published.has(version)) this.snapshotCache.set(version, snap);
  return snap;
}

function publishVersion(version, opts = {}) {
  const snap = snapshotAt.call(this, version);
  if (this.published.has(version)) return this.published.get(version).cert;

  const cert = computeCert(snap);
  const certDoc = {
    version,
    cert,
    keyCount: snap.size,
    publishedAt: new Date().toISOString(),
  };

  if (opts.crashAt === 'before-cert') this.crash();

  const certPath = path.join(this.pubDir, `${version}.cert`);
  const tmpPath = certPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(certDoc, null, 2) + '\n');
  const f = fs.openSync(tmpPath, 'r+');
  fs.fsyncSync(f);
  fs.closeSync(f);
  fs.renameSync(tmpPath, certPath);
  syncDir(this.pubDir);

  if (opts.crashAt === 'after-cert') this.crash();

  this.wal.write({ type: 'publish', version, cert, ts: Date.now() });
  this.wal.sync();

  this.published.set(version, certDoc);
  for (const k of snap.keys()) this.frozenKeys.add(k);
  this.snapshotCache.set(version, snap);
  return cert;
}

function tamperCheck(version) {
  const snap = snapshotAt.call(this, version);
  const expected = this.published.get(version).cert;
  if (computeCert(snap) !== expected) throw tamperError(version);
  return snap;
}

export function openStore(dir, opts = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const pubDir = path.join(dir, 'published');
  fs.mkdirSync(pubDir, { recursive: true });

  const wal = new Wal(path.join(dir, 'wal.log'));
  const store = {
    dir,
    pubDir,
    wal,
    crashMode: opts.crashMode || 'exit',
    commits: [],
    published: new Map(),
    frozenKeys: new Set(),
    snapshotCache: new Map(),
  };

  // Replay WAL: apply commits, validate publish events against cert files.
  const publishedFromWal = new Map();
  for (const rec of wal.replay()) {
    if (rec.type === 'commit') {
      if (rec.version !== store.commits.length + 1) {
        throw new StoreError('RECOVERY', `version gap: expected ${store.commits.length + 1}, got ${rec.version}`);
      }
      store.commits.push({ version: rec.version, writes: rec.writes });
    } else if (rec.type === 'publish') {
      publishedFromWal.set(rec.version, rec.cert);
    }
  }

  // A version is published iff its cert file exists on disk (crash-safe).
  for (const file of fs.readdirSync(pubDir)) {
    const m = /^(\d+)\.cert$/.exec(file);
    if (!m) continue;
    const certDoc = JSON.parse(fs.readFileSync(path.join(pubDir, file), 'utf8'));
    store.published.set(certDoc.version, certDoc);
  }
  // Cross-check: publish events in WAL without cert file are rolled back.
  for (const [version, cert] of publishedFromWal) {
    if (!store.published.has(version)) {
      // publish crashed before cert was durable -> version stays a draft
      continue;
    }
    if (store.published.get(version).cert !== cert) {
      throw new StoreError(TAMPER, `cert file for version ${version} does not match WAL`);
    }
  }
  for (const [version] of store.published) {
    const snap = snapshotAt.call(store, version);
    store.snapshotCache.set(version, snap);
    for (const k of snap.keys()) store.frozenKeys.add(k);
  }

  store.begin = () => beginTxn(store);
  store.commit = (writes) => commitWrites(store, writes);
  store.publish = (version, opts2 = {}) => publishVersion.call(store, version, { ...opts, ...opts2 });
  store.snapshotAt = (version) => snapshotAt.call(store, version);
  store.getAt = (key, version) => snapshotAt.call(store, version).get(key);
  store.get = (key) => snapshotAt.call(store, store.commits.length).get(key);
  store.currentVersion = () => store.commits.length;
  store.isPublished = (version) => store.published.has(version);
  store.publishedVersions = () => [...store.published.keys()].sort((a, b) => a - b);
  store.certOf = (version) => {
    if (!store.published.has(version)) throw versionError(version);
    return store.published.get(version).cert;
  };
  store.versionForCert = (cert) => {
    for (const [version, doc] of store.published) {
      if (doc.cert === cert) return version;
    }
    throw new StoreError(NO_VERSION, `no published version matches cert ${cert}`);
  };
  store.verify = ({ version, cert: certArg } = {}) => {
    let v = version;
    if (v == null) v = store.versionForCert(certArg);
    if (!store.published.has(v)) throw versionError(v);
    tamperCheck.call(store, v);
    return { version: v, cert: store.published.get(v).cert };
  };
  store.getPublished = (key, { version, cert: certArg } = {}) => {
    let v = version;
    if (v == null) v = store.versionForCert(certArg);
    if (!store.published.has(v)) throw versionError(v);
    const snap = tamperCheck.call(store, v);
    return snap.get(key);
  };
  store.close = () => wal.close();
  store.crash = () => {
    if (store.crashMode === 'throw') throw new SimulatedCrash();
    process.exit(70);
  };
  return store;
}

function beginTxn(store) {
  const baseVersion = store.commits.length;
  const writes = new Map();
  const base = snapshotAt.call(store, baseVersion);
  return {
    baseVersion,
    get: (key) => (writes.has(key) ? writes.get(key) : base.get(key)),
    put: (key, value) => {
      if (typeof key !== 'string' || typeof value !== 'string') {
        throw new StoreError('BAD_VALUE', 'keys and values must be strings');
      }
      writes.set(key, value);
    },
    commit: () => commitWrites(store, writes),
  };
}

function commitWrites(store, writes) {
  const frozenHits = [];
  for (const key of writes.keys()) {
    if (store.frozenKeys.has(key)) frozenHits.push(key);
  }
  if (frozenHits.length > 0) throw freezeErrorForKeys(frozenHits);

  const version = store.commits.length + 1;
  const writesObj = Object.fromEntries(writes);
  walAppend(store.wal, { type: 'commit', version, writes: writesObj });
  store.commits.push({ version, writes: writesObj });
  return version;
}

function walAppend(wal, rec) {
  wal.write(rec);
  wal.sync();
}

function computeCert(snapMap) {
  const hash = crypto.createHash('sha256');
  const keys = [...snapMap.keys()].sort();
  hash.update(`snapstore/v1\n${keys.length}\n`, 'utf8');
  for (const k of keys) {
    hash.update(k, 'utf8');
    hash.update('\0', 'utf8');
    hash.update(snapMap.get(k), 'utf8');
    hash.update('\0', 'utf8');
  }
  return hash.digest('hex');
}

function syncDir(dir) {
  try {
    const fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
  } catch {
    // best effort on filesystems that don't allow directory fsync
  }
}

class Wal {
  constructor(file) {
    this.file = file;
    this.fd = fs.openSync(file, 'a+');
  }
  replay() {
    const data = fs.readFileSync(this.file, 'utf8');
    const recs = [];
    let corrupted = false;
    for (const line of data.split('\n')) {
      if (!line.trim()) continue;
      try {
        recs.push(JSON.parse(line));
      } catch {
        // tolerate a torn tail write (crash during append)
        corrupted = true;
        break;
      }
    }
    if (corrupted) {
      // truncate the torn tail
      const clean = recs.map((r) => JSON.stringify(r)).join('\n') + (recs.length ? '\n' : '');
      fs.writeFileSync(this.file, clean);
      fs.fsyncSync(this.fd);
    }
    return recs;
  }
  write(rec) {
    fs.writeSync(this.fd, JSON.stringify(rec) + '\n');
  }
  sync() {
    fs.fsyncSync(this.fd);
  }
  close() {
    fs.fsyncSync(this.fd);
    fs.closeSync(this.fd);
  }
}
