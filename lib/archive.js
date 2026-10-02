'use strict';

// Archive repair library.
//
// Archive layout (a directory):
//   manifest.json            chunk table: length, rolling (adler32) checksum, sha256 per chunk
//   chunks/chunk-000000.bin  chunk payloads
//
// Damage rule: a chunk is corrupt iff its strong hash (sha256) fails. The
// rolling checksum is a fast pre-check only: a weak-checksum hit does NOT
// clear a chunk whose strong hash fails (weak collision), and a weak miss
// with a strong pass is still trusted. Missing chunk files are corrupt.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

class ArchiveError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'ArchiveError';
    this.code = code;
  }
}

const MOD_ADLER = 65521;
const NMAX = 5552; // largest n such that 255n(n+1)/2 + (n+1)(MOD-1) <= 2^32-1

function adler32(buf) {
  let a = 1;
  let b = 0;
  for (let off = 0; off < buf.length;) {
    const end = Math.min(off + NMAX, buf.length);
    for (let i = off; i < end; i++) {
      a += buf[i];
      b += a;
    }
    a %= MOD_ADLER;
    b %= MOD_ADLER;
    off = end;
  }
  return ((b << 16) | a) >>> 0;
}

function adler32hex(buf) {
  return adler32(buf).toString(16).padStart(8, '0');
}

function sha256hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function chunkFileName(index) {
  return `chunks/chunk-${String(index).padStart(6, '0')}.bin`;
}

function createArchive(dir, chunks) {
  fs.mkdirSync(path.join(dir, 'chunks'), { recursive: true });
  const entries = chunks.map((data, index) => {
    const file = chunkFileName(index);
    fs.writeFileSync(path.join(dir, file), data);
    return {
      index,
      file,
      length: data.length,
      adler32: adler32hex(data),
      sha256: sha256hex(data),
    };
  });
  const manifest = { version: 1, chunks: entries };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

function loadManifest(dir) {
  const p = path.join(dir, 'manifest.json');
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    throw new ArchiveError('ERR_IO', `cannot read manifest ${p}: ${e.message}`, { cause: e });
  }
  let m;
  try {
    m = JSON.parse(raw);
  } catch {
    throw new ArchiveError('ERR_CRC', `manifest ${p} is not valid JSON`);
  }
  if (!m || !Array.isArray(m.chunks)) {
    throw new ArchiveError('ERR_CRC', `manifest ${p} has no chunks array`);
  }
  let prev = -1;
  for (const c of m.chunks) {
    const ok = c && Number.isInteger(c.index) && typeof c.file === 'string' &&
      Number.isInteger(c.length) && c.length >= 0 &&
      typeof c.adler32 === 'string' && typeof c.sha256 === 'string';
    if (!ok) throw new ArchiveError('ERR_CRC', `manifest ${p} has a malformed chunk entry`);
    if (c.index <= prev) throw new ArchiveError('ERR_CRC', `manifest ${p} chunk indices not increasing`);
    prev = c.index;
  }
  return m;
}

function inspect(dir) {
  const manifest = loadManifest(dir);
  const chunks = [];
  const corrupt = [];
  for (const entry of manifest.chunks) {
    const p = path.join(dir, entry.file);
    let status = 'ok';
    let reason = null;
    let data = null;
    try {
      data = fs.readFileSync(p);
    } catch {
      status = 'corrupt';
      reason = 'missing';
    }
    if (data) {
      const weakOk = data.length === entry.length && adler32hex(data) === entry.adler32;
      const strongOk = sha256hex(data) === entry.sha256;
      if (!strongOk) {
        status = 'corrupt';
        reason = weakOk ? 'weak-collision' : 'checksum';
      }
    }
    if (status === 'corrupt') corrupt.push(entry.index);
    chunks.push({ index: entry.index, file: entry.file, status, reason });
  }
  return {
    archive: path.resolve(dir),
    ok: corrupt.length === 0,
    total: chunks.length,
    corruptCount: corrupt.length,
    corrupt,
    chunks,
  };
}

function verify(dir) {
  const report = inspect(dir);
  return { archive: report.archive, ok: report.ok, corrupt: report.corrupt };
}

function planRepair(archiveDir, knownGoodDir, maxBytes) {
  const budget = typeof maxBytes === 'string' ? Number(maxBytes) : maxBytes;
  if (!Number.isInteger(budget) || budget < 0) {
    throw new ArchiveError('ERR_BUDGET', `invalid maxBytes: ${maxBytes}`);
  }
  const manifest = loadManifest(archiveDir);
  const report = inspect(archiveDir);
  const base = {
    archive: path.resolve(archiveDir),
    knownGood: path.resolve(knownGoodDir),
    maxBytes: budget,
  };
  if (report.corrupt.length === 0) {
    return { ...base, totalBytes: 0, repairs: [] };
  }
  const goodManifest = loadManifest(knownGoodDir);
  const byHash = new Map();
  for (const c of goodManifest.chunks) {
    const p = path.resolve(knownGoodDir, c.file);
    if (!byHash.has(c.sha256)) byHash.set(c.sha256, []);
    byHash.get(c.sha256).push(p);
  }
  const byIndex = new Map(manifest.chunks.map((c) => [c.index, c]));
  const repairs = [];
  let total = 0;
  for (const idx of report.corrupt) {
    const entry = byIndex.get(idx);
    const candidates = (byHash.get(entry.sha256) || []).slice().sort();
    const contents = new Map(); // real sha256 -> source path (first, lexicographic)
    for (const p of candidates) {
      let data;
      try {
        data = fs.readFileSync(p);
      } catch (e) {
        throw new ArchiveError('ERR_IO', `cannot read source ${p}: ${e.message}`, { cause: e });
      }
      const real = sha256hex(data);
      if (!contents.has(real)) contents.set(real, p);
    }
    if (contents.size > 1) {
      throw new ArchiveError('ERR_SOURCE',
        `conflicting sources for sha256 ${entry.sha256}: same claimed hash, different content`);
    }
    let source = null;
    if (contents.size === 1) {
      const [real, p] = contents.entries().next().value;
      if (real === entry.sha256) source = p;
    }
    if (!source) break; // no usable source: prefix stops here
    if (total + entry.length > budget) break; // budget exceeded: prefix stops here
    total += entry.length;
    repairs.push({ index: idx, bytes: entry.length, sha256: entry.sha256, source });
  }
  return { ...base, totalBytes: total, repairs };
}

function applyPlan(archiveDir, plan, opts = {}) {
  const manifest = loadManifest(archiveDir);
  if (!plan || !Array.isArray(plan.repairs)) {
    throw new ArchiveError('ERR_CRC', 'invalid plan: missing repairs array');
  }
  const byIndex = new Map(manifest.chunks.map((c) => [c.index, c]));
  // Validate plan and read/verify every source BEFORE touching the archive.
  const staged = [];
  for (const r of plan.repairs) {
    const entry = byIndex.get(r.index);
    if (!entry) throw new ArchiveError('ERR_CRC', `plan references unknown chunk ${r.index}`);
    if (entry.sha256 !== r.sha256) {
      throw new ArchiveError('ERR_CRC', `plan hash mismatch for chunk ${r.index}`);
    }
    let data;
    try {
      data = fs.readFileSync(r.source);
    } catch (e) {
      throw new ArchiveError('ERR_IO', `cannot read source ${r.source}: ${e.message}`, { cause: e });
    }
    if (sha256hex(data) !== r.sha256) {
      throw new ArchiveError('ERR_SOURCE', `source ${r.source} content does not match plan hash`);
    }
    staged.push({ entry, data, tmp: null });
  }
  const tmpDir = path.join(archiveDir, `.apply-tmp-${process.pid}-${Date.now()}`);
  const backups = []; // { target, backup|null } for chunks whose commit has begun
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    for (const s of staged) {
      s.tmp = path.join(tmpDir, `new-${path.basename(s.entry.file)}`);
      fs.writeFileSync(s.tmp, s.data);
    }
    for (let i = 0; i < staged.length; i++) {
      if (opts.onBeforeCommit) opts.onBeforeCommit(i); // test hook for failure injection
      const s = staged[i];
      const target = path.join(archiveDir, s.entry.file);
      let backup = null;
      if (fs.existsSync(target)) {
        backup = path.join(tmpDir, `backup-${path.basename(s.entry.file)}`);
        fs.renameSync(target, backup);
      }
      backups.push({ target, backup });
      fs.renameSync(s.tmp, target);
    }
  } catch (e) {
    // Roll back: remove any placed new file, restore every backup.
    for (let i = backups.length - 1; i >= 0; i--) {
      const { target, backup } = backups[i];
      try {
        if (fs.existsSync(target)) fs.rmSync(target, { force: true });
      } catch { /* best effort */ }
      try {
        if (backup && fs.existsSync(backup)) fs.renameSync(backup, target);
      } catch { /* best effort */ }
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* best effort */ }
    if (e instanceof ArchiveError) throw e;
    throw new ArchiveError('ERR_IO', `applyPlan failed, archive rolled back: ${e.message}`, { cause: e });
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch { /* best effort */ }
  return { archive: path.resolve(archiveDir), ok: true, applied: staged.map((s) => s.entry.index) };
}

module.exports = {
  ArchiveError,
  adler32,
  adler32hex,
  sha256hex,
  chunkFileName,
  createArchive,
  loadManifest,
  inspect,
  verify,
  planRepair,
  applyPlan,
};
