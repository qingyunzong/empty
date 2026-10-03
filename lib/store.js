'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { adler32, chunkBuffer } = require('./cdc');

class SnapError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SnapError';
    this.code = code;
  }
}

function sha256hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function canonPath(p) {
  return p.split(/[\\/]+/).filter((s) => s && s !== '.').join('/');
}

function comparePaths(pa, pb) {
  return Buffer.compare(Buffer.from(pa, 'utf8'), Buffer.from(pb, 'utf8'));
}

function fsyncDir(dir) {
  try {
    const fd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch { /* best effort on non-Linux */ }
}

function writeJsonSynced(file, obj) {
  const fd = fs.openSync(file, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(obj));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function writeFileAtomicSynced(file, data) {
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  fsyncDir(path.dirname(file));
}

const paths = {
  chunks: (repo) => path.join(repo, 'chunks'),
  chunksTmp: (repo) => path.join(repo, 'chunks', 'tmp'),
  chunk: (repo, sha) => path.join(repo, 'chunks', sha),
  tmpChunk: (repo, sha) => path.join(repo, 'chunks', 'tmp', sha + '.tmp'),
  log: (repo) => path.join(repo, 'log'),
  pending: (repo) => path.join(repo, 'log', 'pending.json'),
  index: (repo) => path.join(repo, 'index'),
  indexFile: (repo, v) => path.join(repo, 'index', v + '.json'),
  head: (repo) => path.join(repo, 'index', 'HEAD'),
};

function ensureRepo(repo) {
  fs.mkdirSync(paths.chunksTmp(repo), { recursive: true });
  fs.mkdirSync(paths.log(repo), { recursive: true });
  fs.mkdirSync(paths.index(repo), { recursive: true });
}

function readHead(repo) {
  try {
    return fs.readFileSync(paths.head(repo), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function scanDir(root) {
  const out = [];
  (function walk(dir, rel) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? rel + '/' + ent.name : ent.name;
      if (ent.isDirectory()) walk(path.join(dir, ent.name), r);
      else if (ent.isFile()) out.push(canonPath(r));
    }
  })(root, '');
  out.sort(comparePaths);
  return out;
}

function fileDigest(f) {
  return f.chunks.map((c) => c.sha256).join(':');
}

function crash(message) {
  const err = new SnapError('ERR_CRASH', message);
  err.simulatedCrash = true;
  throw err;
}

// Write order: temp chunks -> log -> index commit point (HEAD).
function writeSnapshot(repo, srcDir, opts = {}) {
  const fault = opts.fault || null;
  ensureRepo(repo);
  if (fs.existsSync(paths.pending(repo))) {
    throw new SnapError('ERR_DIRTY', 'uncommitted snapshot log present; run resume first');
  }

  const files = scanDir(srcDir);
  const manifestFiles = [];
  const newChunks = [];
  const seen = new Set();
  for (const rel of files) {
    const data = fs.readFileSync(path.join(srcDir, ...rel.split('/')));
    const chunks = [];
    for (const piece of chunkBuffer(data)) {
      const sha = sha256hex(piece);
      chunks.push({ sha256: sha, adler32: adler32(piece), size: piece.length });
      if (!seen.has(sha) && !fs.existsSync(paths.chunk(repo, sha))) {
        seen.add(sha);
        newChunks.push({ sha256: sha, data: Buffer.from(piece) });
      }
    }
    manifestFiles.push({ path: rel, size: data.length, chunks });
  }

  const manifest = { format: 1, files: manifestFiles };
  const version = sha256hex(Buffer.from(JSON.stringify(manifest), 'utf8')).slice(0, 16);

  if (readHead(repo) === version) {
    return { version, committed: false, unchanged: true };
  }

  // Phase 1: temp chunks (write to tmp, fsync, atomic rename into place).
  let faulted = false;
  for (const c of newChunks) {
    const tmp = paths.tmpChunk(repo, c.sha256);
    if (fault && fault.type === 'chunk-partial' && !faulted) {
      faulted = true;
      fs.writeFileSync(tmp, c.data.subarray(0, Math.max(1, Math.floor(c.data.length / 2))));
      crash('simulated power loss: chunk written half-way');
    }
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, c.data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, paths.chunk(repo, c.sha256));
  }
  fsyncDir(paths.chunks(repo));
  fsyncDir(paths.chunksTmp(repo));

  // Phase 2: write-ahead log.
  writeJsonSynced(paths.pending(repo), {
    version,
    manifest,
    chunks: newChunks.map((c) => c.sha256),
  });
  fsyncDir(paths.log(repo));
  if (fault && fault.type === 'log-no-commit') {
    crash('simulated power loss: log written, index not committed');
  }

  // Phase 3: index commit point.
  const idxFile = paths.indexFile(repo, version);
  if (fault && fault.type === 'index-no-fsync') {
    fs.writeFileSync(idxFile, JSON.stringify({ version, manifest })); // no fsync, no HEAD
    crash('simulated power loss: index written but not fsynced/committed');
  }
  writeJsonSynced(idxFile, { version, manifest });
  writeFileAtomicSynced(paths.head(repo), version + '\n');
  fsyncDir(paths.index(repo));

  fs.unlinkSync(paths.pending(repo));
  fsyncDir(paths.log(repo));
  return { version, committed: true, unchanged: false };
}

// Roll back to the most recent commit point; temp chunks are cleaned.
function resume(repo) {
  ensureRepo(repo);
  const head = readHead(repo);
  let rolledBack = false;

  const tmpDir = paths.chunksTmp(repo);
  for (const f of fs.readdirSync(tmpDir)) {
    fs.unlinkSync(path.join(tmpDir, f));
  }

  const pendingFile = paths.pending(repo);
  if (fs.existsSync(pendingFile)) {
    rolledBack = true;
    let log = null;
    try {
      log = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
    } catch { /* corrupt log is discarded */ }
    if (log && log.version && log.version !== head) {
      const orphan = paths.indexFile(repo, log.version);
      if (fs.existsSync(orphan)) fs.unlinkSync(orphan);
    }
    fs.unlinkSync(pendingFile);
    fsyncDir(paths.log(repo));
    fsyncDir(paths.index(repo));
  }
  fsyncDir(tmpDir);
  return { version: head, rolledBack };
}

function loadManifest(repo, version) {
  const file = paths.indexFile(repo, version);
  if (!fs.existsSync(file)) {
    throw new SnapError('ERR_VERSION', 'unknown version: ' + version);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function listVersions(repo) {
  try {
    return fs.readdirSync(paths.index(repo))
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -5))
      .sort();
  } catch {
    return [];
  }
}

// Global verification: every chunk in the store is hash-checked, and every
// chunk referenced by any committed version is checked against the chunk
// table (Adler32 weak + SHA256 strong).
function verify(repo) {
  if (fs.existsSync(paths.pending(repo))) {
    throw new SnapError('ERR_CRASH', 'uncommitted snapshot log present; run resume first');
  }
  const head = readHead(repo);
  const referenced = new Map();
  for (const v of listVersions(repo)) {
    const { manifest } = loadManifest(repo, v);
    for (const f of manifest.files) {
      for (const c of f.chunks) referenced.set(c.sha256, c);
    }
  }

  const chunksDir = paths.chunks(repo);
  let stored = 0;
  for (const f of fs.readdirSync(chunksDir)) {
    if (!/^[0-9a-f]{64}$/.test(f)) continue;
    stored++;
    const data = fs.readFileSync(path.join(chunksDir, f));
    if (sha256hex(data) !== f) {
      throw new SnapError('ERR_CHUNK', 'chunk ' + f + ' failed SHA256 verification');
    }
  }

  for (const [sha, meta] of referenced) {
    const file = paths.chunk(repo, sha);
    if (!fs.existsSync(file)) {
      throw new SnapError('ERR_CHUNK', 'referenced chunk missing: ' + sha);
    }
    const data = fs.readFileSync(file);
    if (sha256hex(data) !== sha) {
      throw new SnapError('ERR_CHUNK', 'chunk ' + sha + ' failed SHA256 verification');
    }
    if (data.length !== meta.size || adler32(data) !== meta.adler32) {
      throw new SnapError('ERR_CHUNK', 'chunk ' + sha + ' failed Adler32/size verification');
    }
  }
  return { ok: true, version: head, versions: listVersions(repo), chunks: stored };
}

// Diff two committed versions. Entries sorted by canonical path, byte order.
function diff(repo, a, b) {
  const ma = loadManifest(repo, a).manifest;
  const mb = loadManifest(repo, b).manifest;
  const fa = new Map(ma.files.map((f) => [f.path, fileDigest(f)]));
  const fb = new Map(mb.files.map((f) => [f.path, fileDigest(f)]));
  const ops = [];
  for (const [p, d] of fb) {
    if (!fa.has(p)) ops.push({ op: 'A', path: p });
    else if (fa.get(p) !== d) ops.push({ op: 'M', path: p });
  }
  for (const p of fa.keys()) {
    if (!fb.has(p)) ops.push({ op: 'D', path: p });
  }
  ops.sort((x, y) => comparePaths(canonPath(x.path), canonPath(y.path)));
  return ops;
}

// Materialize a version. Incremental: when outDir holds a previous
// materialization (marker file), only changed files are rewritten, so only
// changed chunks are read. Every chunk read is hash-verified.
function materialize(repo, version, outDir) {
  const { manifest } = loadManifest(repo, version);
  fs.mkdirSync(outDir, { recursive: true });
  const markerPath = path.join(outDir, '.snapshot.json');
  let prevFiles = new Map();
  if (fs.existsSync(markerPath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
      prevFiles = new Map(prev.manifest.files.map((f) => [f.path, fileDigest(f)]));
    } catch { /* ignore corrupt marker, full rewrite */ }
  }

  const wanted = new Set();
  let rewritten = 0;
  for (const f of manifest.files) {
    wanted.add(f.path);
    if (prevFiles.get(f.path) === fileDigest(f)) continue;
    const parts = f.chunks.map((c) => {
      const data = fs.readFileSync(paths.chunk(repo, c.sha256));
      if (sha256hex(data) !== c.sha256) {
        throw new SnapError('ERR_CHUNK', 'chunk ' + c.sha256 + ' failed SHA256 verification');
      }
      if (data.length !== c.size || adler32(data) !== c.adler32) {
        throw new SnapError('ERR_CHUNK', 'chunk ' + c.sha256 + ' failed Adler32/size verification');
      }
      return data;
    });
    const dest = path.join(outDir, ...f.path.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    writeFileAtomicSynced(dest, Buffer.concat(parts));
    rewritten++;
  }

  for (const p of prevFiles.keys()) {
    if (!wanted.has(p)) {
      const stale = path.join(outDir, ...p.split('/'));
      if (fs.existsSync(stale)) fs.unlinkSync(stale);
    }
  }
  writeJsonSynced(markerPath, { version, manifest });
  return { version, files: manifest.files.length, rewritten };
}

module.exports = {
  SnapError,
  writeSnapshot,
  resume,
  verify,
  diff,
  materialize,
  readHead,
  listVersions,
  canonPath,
  comparePaths,
  _paths: paths,
};
