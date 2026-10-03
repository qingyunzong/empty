'use strict';
// Content-defined-chunking snapshot store with crash-safe commit protocol.
// Write order: temp chunks -> journal -> index commit point (atomic rename).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const CHUNK_DIR = 'chunks';
const TMP_DIR = 'tmp';
const JOURNAL = 'JOURNAL';
const INDEX = 'index.json';
const INDEX_TMP = 'index.json.tmp';
const STATE_FILE = '.snapshot-state.json';

const DEFAULT_PARAMS = Object.freeze({ min: 2048, avg: 8192, max: 65536 });
const FAULTS = new Set(['chunk-partial', 'journal-uncommitted', 'index-no-fsync']);

class SnapError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'SnapError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

class SimulatedCrash extends Error {
  constructor(point) {
    super(`simulated power loss at crash point: ${point}`);
    this.name = 'SimulatedCrash';
    this.point = point;
  }
}

// ---------- checksums ----------
function adler32hex(buf) {
  const MOD = 65521;
  let a = 1, b = 0;
  for (let i = 0; i < buf.length; i++) {
    a += buf[i];
    b += a;
    if ((i & 4095) === 4095) { a %= MOD; b %= MOD; }
  }
  a %= MOD; b %= MOD;
  return ((b << 16) | a) >>> 0;
}

function sha256hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

const byBytes = (x, y) => Buffer.compare(Buffer.from(x, 'utf8'), Buffer.from(y, 'utf8'));

// ---------- content-defined chunking (gear hash, 32-byte window) ----------
function buildGearTable() {
  let s = 0x9e3779b9 >>> 0;
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    s = (s + 0x6d2b79f5) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    t[i] = (z ^ (z >>> 14)) >>> 0;
  }
  return t;
}
const GEAR = buildGearTable();

function splitChunks(buf, params) {
  const { min, avg, max } = params;
  const mask = avg - 1;
  const out = [];
  let start = 0;
  let h = 0;
  for (let i = 0; i < buf.length; i++) {
    h = ((h << 1) + GEAR[buf[i]]) >>> 0;
    const len = i + 1 - start;
    if ((len >= min && (h & mask) === 0) || len >= max) {
      out.push(buf.subarray(start, i + 1));
      start = i + 1;
      h = 0;
    }
  }
  if (start < buf.length) out.push(buf.subarray(start));
  return out;
}

// ---------- fs helpers ----------
function writeFileSyncFsync(file, data) {
  const fd = fs.openSync(file, 'w');
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function fsyncDir(dir) {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function scanDir(src) {
  const out = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const rp = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), rp);
      else if (e.isFile()) out.push({ path: rp, abs: path.join(dir, e.name) });
    }
  };
  walk(src, '');
  out.sort((a, b) => byBytes(a.path, b.path));
  return out;
}

function computeGlobalHash(files) {
  const h = crypto.createHash('sha256');
  const sorted = [...files].sort((a, b) => byBytes(a.path, b.path));
  for (const f of sorted) {
    h.update(f.path, 'utf8'); h.update('\0');
    h.update(String(f.size)); h.update('\0');
    h.update(f.sha256, 'utf8'); h.update('\n');
  }
  return h.digest('hex');
}

// ---------- repo state ----------
function ensureRepo(repo, params) {
  fs.mkdirSync(path.join(repo, CHUNK_DIR), { recursive: true });
  fs.mkdirSync(path.join(repo, TMP_DIR), { recursive: true });
  const idxPath = path.join(repo, INDEX);
  if (!fs.existsSync(idxPath)) {
    const idx = { format: 1, params: params || DEFAULT_PARAMS, versions: [] };
    writeFileSyncFsync(path.join(repo, INDEX_TMP), JSON.stringify(idx, null, 2));
    fs.renameSync(path.join(repo, INDEX_TMP), idxPath);
    fsyncDir(repo);
  }
}

function dirtyState(repo) {
  const journal = fs.existsSync(path.join(repo, JOURNAL));
  const indexTmp = fs.existsSync(path.join(repo, INDEX_TMP));
  let tmpFiles = [];
  try { tmpFiles = fs.readdirSync(path.join(repo, TMP_DIR)); } catch { /* no tmp dir */ }
  return { dirty: journal || indexTmp || tmpFiles.length > 0, journal, indexTmp, tmpFiles };
}

function loadIndexRaw(repo) {
  const idxPath = path.join(repo, INDEX);
  if (!fs.existsSync(idxPath)) throw new SnapError('ERR_CRASH', `committed index missing: ${idxPath}`);
  try {
    return JSON.parse(fs.readFileSync(idxPath, 'utf8'));
  } catch (e) {
    throw new SnapError('ERR_CRASH', `committed index corrupt: ${e.message}`);
  }
}

function loadIndex(repo) {
  const d = dirtyState(repo);
  if (d.dirty) {
    throw new SnapError('ERR_DIRTY', 'repo has uncommitted state (crash detected); run resume first', {
      journal: d.journal, indexTmp: d.indexTmp, tempChunks: d.tmpFiles.length,
    });
  }
  return loadIndexRaw(repo);
}

// ---------- API ----------
function writeSnapshot(repo, srcDir, opts = {}) {
  const fault = opts.fault || null;
  if (fault && !FAULTS.has(fault)) throw new SnapError('ERR_VERSION', `unknown fault injection: ${fault}`);
  ensureRepo(repo, opts.params);
  const index = loadIndex(repo);
  const params = index.params;

  const manifestFiles = [];
  let chunkFaultArmed = fault === 'chunk-partial';
  for (const f of scanDir(srcDir)) {
    const data = fs.readFileSync(f.abs);
    const chunkRecs = [];
    for (const c of splitChunks(data, params)) {
      const sha = sha256hex(c);
      chunkRecs.push({ sha256: sha, adler32: adler32hex(c), size: c.length });
      const dest = path.join(repo, CHUNK_DIR, sha);
      if (fs.existsSync(dest)) continue;
      const tmp = path.join(repo, TMP_DIR, sha + '.tmp');
      if (chunkFaultArmed) {
        chunkFaultArmed = false;
        // crash point 3: block written half-way, no fsync, no rename
        const fd = fs.openSync(tmp, 'w');
        fs.writeFileSync(fd, c.subarray(0, Math.max(1, Math.floor(c.length / 2))));
        fs.closeSync(fd);
        throw new SimulatedCrash('chunk-partial');
      }
      writeFileSyncFsync(tmp, c);
      fs.renameSync(tmp, dest);
      fsyncDir(path.join(repo, CHUNK_DIR));
    }
    manifestFiles.push({ path: f.path, size: data.length, sha256: sha256hex(data), chunks: chunkRecs });
  }

  const globalHash = computeGlobalHash(manifestFiles);
  const last = index.versions[index.versions.length - 1];
  if (last && last.globalHash === globalHash) {
    return { version: last.id, created: false, globalHash };
  }

  const entry = { id: (last ? last.id : 0) + 1, globalHash, files: manifestFiles };

  // phase 2: journal (write-ahead log), fsynced
  writeFileSyncFsync(path.join(repo, JOURNAL), JSON.stringify({ entry }));
  fsyncDir(repo);
  if (fault === 'journal-uncommitted') throw new SimulatedCrash('journal-uncommitted');

  // phase 3: index commit point
  const nextIndex = { ...index, versions: [...index.versions, entry] };
  const tmpIndex = path.join(repo, INDEX_TMP);
  if (fault === 'index-no-fsync') {
    // crash point 2: index written but never fsynced / never renamed -> not committed
    fs.writeFileSync(tmpIndex, JSON.stringify(nextIndex, null, 2));
    throw new SimulatedCrash('index-no-fsync');
  }
  writeFileSyncFsync(tmpIndex, JSON.stringify(nextIndex, null, 2));
  fs.renameSync(tmpIndex, path.join(repo, INDEX));
  fsyncDir(repo);
  fs.unlinkSync(path.join(repo, JOURNAL));
  fsyncDir(repo);
  return { version: entry.id, created: true, globalHash };
}

function resume(repo) {
  if (!fs.existsSync(repo)) throw new SnapError('ERR_CRASH', `repo not found: ${repo}`);
  const index = loadIndexRaw(repo); // committed state is the source of truth
  const last = index.versions[index.versions.length - 1];
  const d = dirtyState(repo);
  if (!d.dirty) return { status: 'clean', version: last ? last.id : null };

  let discardedVersion = null;
  if (d.journal) {
    try { discardedVersion = JSON.parse(fs.readFileSync(path.join(repo, JOURNAL), 'utf8')).entry.id; } catch { /* unparseable uncommitted journal: discard */ }
    fs.unlinkSync(path.join(repo, JOURNAL));
  }
  if (d.indexTmp) fs.unlinkSync(path.join(repo, INDEX_TMP));
  let removedTempChunks = 0;
  for (const t of d.tmpFiles) {
    fs.unlinkSync(path.join(repo, TMP_DIR, t));
    removedTempChunks++;
  }
  fsyncDir(repo);
  return {
    status: 'recovered',
    version: last ? last.id : null,
    discardedVersion,
    removedTempChunks,
  };
}

function verify(repo, versionId) {
  const index = loadIndex(repo);
  let versions = index.versions;
  if (versionId !== undefined && versionId !== null) {
    const v = versions.find((x) => x.id === Number(versionId));
    if (!v) throw new SnapError('ERR_VERSION', `version not found: ${versionId}`);
    versions = [v];
  }
  const problems = [];
  const chunkDir = path.join(repo, CHUNK_DIR);
  const storeFiles = fs.existsSync(chunkDir) ? fs.readdirSync(chunkDir) : [];
  // every block in the store must match its content-defined name
  for (const name of storeFiles) {
    const data = fs.readFileSync(path.join(chunkDir, name));
    if (sha256hex(data) !== name) problems.push({ chunk: name, reason: 'sha256-mismatch' });
  }
  // every referenced block must exist and match weak + strong checksums
  for (const v of versions) {
    for (const f of v.files) {
      for (const c of f.chunks) {
        const p = path.join(chunkDir, c.sha256);
        if (!fs.existsSync(p)) {
          problems.push({ chunk: c.sha256, version: v.id, path: f.path, reason: 'missing' });
          continue;
        }
        const data = fs.readFileSync(p);
        if (data.length !== c.size) problems.push({ chunk: c.sha256, version: v.id, path: f.path, reason: 'size-mismatch' });
        if (adler32hex(data) !== c.adler32) problems.push({ chunk: c.sha256, version: v.id, path: f.path, reason: 'adler32-mismatch' });
        if (sha256hex(data) !== c.sha256) problems.push({ chunk: c.sha256, version: v.id, path: f.path, reason: 'sha256-mismatch' });
      }
    }
    if (computeGlobalHash(v.files) !== v.globalHash) {
      problems.push({ version: v.id, reason: 'global-hash-mismatch' });
    }
  }
  if (problems.length) {
    throw new SnapError('ERR_CHUNK', `${problems.length} chunk integrity problem(s)`, { problems: problems.slice(0, 10) });
  }
  return { ok: true, chunks: storeFiles.length, versions: versions.length };
}

function findVersion(index, id) {
  const v = index.versions.find((x) => x.id === Number(id));
  if (!v) throw new SnapError('ERR_VERSION', `version not found: ${id}`);
  return v;
}

function diff(repo, aId, bId) {
  const index = loadIndex(repo);
  const a = findVersion(index, aId);
  const b = findVersion(index, bId);
  const am = new Map(a.files.map((f) => [f.path, f.sha256]));
  const bm = new Map(b.files.map((f) => [f.path, f.sha256]));
  const out = [];
  for (const [p, h] of bm) {
    if (!am.has(p)) out.push({ op: 'added', path: p });
    else if (am.get(p) !== h) out.push({ op: 'modified', path: p });
  }
  for (const p of am.keys()) {
    if (!bm.has(p)) out.push({ op: 'removed', path: p });
  }
  out.sort((x, y) => byBytes(x.path, y.path));
  return out;
}

function materialize(repo, versionId, dest) {
  const index = loadIndex(repo);
  const v = findVersion(index, versionId);
  fs.mkdirSync(dest, { recursive: true });
  let state = { version: null, files: {} };
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dest, STATE_FILE), 'utf8'));
    if (s && s.files) state = s;
  } catch { /* no usable prior state: full decode */ }

  const stats = { version: v.id, filesWritten: 0, filesReused: 0, filesRemoved: 0, chunksRead: 0 };
  const newFiles = {};
  for (const f of v.files) {
    const target = path.join(dest, ...f.path.split('/'));
    const rec = state.files[f.path];
    let hash = null;
    if (rec && rec.sha256 === f.sha256 && fs.existsSync(target)) {
      const cur = sha256hex(fs.readFileSync(target));
      if (cur === f.sha256) {
        hash = cur; // unchanged file: no chunk reads
        stats.filesReused++;
      }
    }
    if (hash === null) {
      const parts = [];
      for (const c of f.chunks) {
        const p = path.join(repo, CHUNK_DIR, c.sha256);
        if (!fs.existsSync(p)) throw new SnapError('ERR_CHUNK', `missing chunk ${c.sha256} for ${f.path}`);
        const data = fs.readFileSync(p);
        stats.chunksRead++;
        if (data.length !== c.size || adler32hex(data) !== c.adler32 || sha256hex(data) !== c.sha256) {
          throw new SnapError('ERR_CHUNK', `corrupt chunk ${c.sha256} for ${f.path}`);
        }
        parts.push(data);
      }
      const content = Buffer.concat(parts);
      hash = sha256hex(content);
      if (hash !== f.sha256) throw new SnapError('ERR_CHUNK', `file hash mismatch: ${f.path}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const tmp = target + '.tmp';
      writeFileSyncFsync(tmp, content);
      fs.renameSync(tmp, target);
      stats.filesWritten++;
    }
    newFiles[f.path] = { sha256: hash, size: f.size };
  }
  for (const oldPath of Object.keys(state.files)) {
    if (!(oldPath in newFiles)) {
      try { fs.unlinkSync(path.join(dest, ...oldPath.split('/'))); stats.filesRemoved++; } catch { /* already gone */ }
    }
  }
  // global checksum covers the full content, including reused files
  const g = computeGlobalHash(v.files.map((f) => ({ path: f.path, size: f.size, sha256: newFiles[f.path].sha256 })));
  if (g !== v.globalHash) throw new SnapError('ERR_CHUNK', 'global checksum mismatch after materialize');
  writeFileSyncFsync(path.join(dest, STATE_FILE), JSON.stringify({ version: v.id, files: newFiles }, null, 2));
  return stats;
}

module.exports = {
  writeSnapshot, resume, verify, diff, materialize,
  splitChunks, computeGlobalHash, adler32hex, sha256hex,
  SnapError, SimulatedCrash, DEFAULT_PARAMS, STATE_FILE,
};
