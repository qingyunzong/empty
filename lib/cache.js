'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { crc32 } = require('./crc32');
const { sha256, leafHash, merkleRoot } = require('./merkle');

const CERT_TYPE = 'sample-cache-cert';
const META_FILE = 'meta.json';
const CERTS_FILE = 'certs.json';
const BLOCKS_DIR = 'blocks';

class CacheError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CacheError';
    this.code = code;
  }
}

function bitmapBytes(n) { return Math.ceil(n / 8); }
function setBit(buf, i) { buf[i >> 3] |= 1 << (i & 7); }
function getBit(buf, i) { return (buf[i >> 3] >> (i & 7)) & 1; }
function fullBitmap(n) {
  const b = Buffer.alloc(bitmapBytes(n));
  for (let i = 0; i < n; i++) setBit(b, i);
  return b;
}
function concatBitmaps(b1, n1, b2, n2) {
  const out = Buffer.alloc(bitmapBytes(n1 + n2));
  for (let i = 0; i < n1; i++) if (getBit(b1, i)) setBit(out, i);
  for (let j = 0; j < n2; j++) if (getBit(b2, j)) setBit(out, n1 + j);
  return out;
}

class SampleCache {
  constructor(cacheDir) {
    this.dir = cacheDir;
    this.samplePath = null;
    this.meta = null;
  }

  static defaultCacheDir(samplePath) { return samplePath + '.cache'; }

  static ingest(samplePath, opts = {}) {
    const cache = new SampleCache(opts.cacheDir || SampleCache.defaultCacheDir(samplePath));
    cache._ingest(samplePath, opts);
    return cache;
  }

  static open(samplePath, opts = {}) {
    const cache = new SampleCache(opts.cacheDir || SampleCache.defaultCacheDir(samplePath));
    cache.samplePath = path.resolve(samplePath);
    cache._loadMeta();
    return cache;
  }

  _ingest(samplePath, opts) {
    const blockSize = opts.blockSize || 1024;
    const capacity = opts.capacity == null ? 1 << 20 : opts.capacity;
    const abs = path.resolve(samplePath);
    if (!(blockSize > 0)) throw new CacheError('ERR_RANGE', 'block size must be positive');
    if (!(capacity >= 0)) throw new CacheError('ERR_RANGE', 'capacity must be non-negative');
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size === 0) {
      throw new CacheError('ERR_RANGE', `sample is empty or not a regular file: ${abs}`);
    }
    const blockCount = Math.ceil(st.size / blockSize);
    const blocks = [];
    const leaves = [];
    const fd = fs.openSync(abs, 'r');
    const chunks = [];
    try {
      for (let i = 0; i < blockCount; i++) {
        const len = Math.min(blockSize, st.size - i * blockSize);
        const data = Buffer.alloc(len);
        fs.readSync(fd, data, 0, len, i * blockSize);
        chunks.push(data);
        const crc = crc32(data);
        blocks.push({ crc, generation: 0, cached: false, lastAccess: 0, size: len });
        leaves.push(leafHash(i, 0, crc, data));
      }
    } finally { fs.closeSync(fd); }
    this.samplePath = abs;
    this.meta = {
      version: 1,
      sampleId: sha256(Buffer.from(`samplecache:v1:${abs}:${st.size}:${blockSize}`)).toString('hex'),
      samplePath: abs,
      size: st.size,
      blockSize,
      blockCount,
      capacity,
      blocks,
      root: merkleRoot(leaves).toString('hex'),
      lruClock: 0,
    };
    fs.rmSync(this.dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(this.dir, BLOCKS_DIR), { recursive: true });
    for (let i = 0; i < blockCount; i++) this._cacheInsert(i, chunks[i]);
    this._saveCerts([]);
    this._saveMeta();
  }

  _requireMeta() {
    if (!this.meta) throw new CacheError('ERR_RANGE', `no cache metadata in ${this.dir}; run ingest first`);
  }

  _blockPath(i) { return path.join(this.dir, BLOCKS_DIR, String(i).padStart(6, '0') + '.bin'); }
  _metaPath() { return path.join(this.dir, META_FILE); }
  _certsPath() { return path.join(this.dir, CERTS_FILE); }

  _loadMeta() {
    let raw;
    try { raw = fs.readFileSync(this._metaPath(), 'utf8'); }
    catch { throw new CacheError('ERR_RANGE', `no cache metadata in ${this.dir}; run ingest first`); }
    this.meta = JSON.parse(raw);
    this.samplePath = this.meta.samplePath;
  }

  _saveMeta() {
    const tmp = this._metaPath() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.meta, null, 2) + '\n');
    fs.renameSync(tmp, this._metaPath());
  }

  _loadCerts() {
    try { return JSON.parse(fs.readFileSync(this._certsPath(), 'utf8')).certs || []; }
    catch { return []; }
  }

  _saveCerts(certs) {
    const tmp = this._certsPath() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ certs }, null, 2) + '\n');
    fs.renameSync(tmp, this._certsPath());
  }

  _touch(i) { this.meta.blocks[i].lastAccess = ++this.meta.lruClock; }

  _cachedBytes() {
    let total = 0;
    for (const b of this.meta.blocks) if (b.cached) total += b.size;
    return total;
  }

  _evict(i) {
    fs.rmSync(this._blockPath(i), { force: true });
    this.meta.blocks[i].cached = false;
  }

  _enforceCapacity() {
    let bytes = this._cachedBytes();
    while (bytes > this.meta.capacity) {
      let victim = -1;
      let oldest = Infinity;
      for (let i = 0; i < this.meta.blocks.length; i++) {
        const b = this.meta.blocks[i];
        if (b.cached && b.lastAccess < oldest) { oldest = b.lastAccess; victim = i; }
      }
      if (victim < 0) break;
      this._evict(victim);
      bytes -= this.meta.blocks[victim].size;
    }
  }

  _cacheInsert(i, data) {
    fs.writeFileSync(this._blockPath(i), data);
    this.meta.blocks[i].cached = true;
    this._touch(i);
    this._enforceCapacity();
  }

  _readSourceRaw(i) {
    const b = this.meta.blocks[i];
    const data = Buffer.alloc(b.size);
    const fd = fs.openSync(this.samplePath, 'r');
    try { fs.readSync(fd, data, 0, b.size, i * this.meta.blockSize); }
    finally { fs.closeSync(fd); }
    return data;
  }

  _readSourceBlock(i) {
    const b = this.meta.blocks[i];
    let st;
    try { st = fs.statSync(this.samplePath); }
    catch { throw new CacheError('ERR_SOURCE', `source unavailable: ${this.samplePath}`); }
    if (st.size !== this.meta.size) {
      throw new CacheError('ERR_SOURCE', `source size ${st.size} != expected ${this.meta.size}`);
    }
    const data = this._readSourceRaw(i);
    if (crc32(data) !== b.crc) {
      throw new CacheError('ERR_SOURCE', `source block ${i} failed CRC; cannot repair cache`);
    }
    return data;
  }

  _readBlock(i) {
    const b = this.meta.blocks[i];
    const p = this._blockPath(i);
    if (b.cached && fs.existsSync(p)) {
      const data = fs.readFileSync(p);
      if (data.length === b.size && crc32(data) === b.crc) {
        this._touch(i);
        return { data, repaired: false, origin: 'cache' };
      }
    }
    const wasCached = b.cached;
    const data = this._readSourceBlock(i);
    this._cacheInsert(i, data);
    return { data, repaired: wasCached, origin: 'source' };
  }

  _recomputeRoot() {
    const leaves = [];
    for (let i = 0; i < this.meta.blockCount; i++) {
      const b = this.meta.blocks[i];
      const { data } = this._readBlock(i);
      leaves.push(leafHash(i, b.generation, b.crc, data));
    }
    this.meta.root = merkleRoot(leaves).toString('hex');
  }

  _snapRange(start, end) {
    if (!Number.isInteger(start) || !Number.isInteger(end) ||
        start < 0 || end > this.meta.size || start >= end) {
      throw new CacheError('ERR_RANGE', `invalid window [${start}, ${end}) for sample size ${this.meta.size}`);
    }
    const bs = this.meta.blockSize;
    return { s: Math.floor(start / bs), e: Math.ceil(end / bs) };
  }

  correctRange(start, end, data) {
    this._requireMeta();
    if (!Number.isInteger(start) || !Number.isInteger(end) ||
        start < 0 || end > this.meta.size || start >= end) {
      throw new CacheError('ERR_RANGE', `invalid range [${start}, ${end}) for sample size ${this.meta.size}`);
    }
    if (!Buffer.isBuffer(data) || data.length !== end - start) {
      throw new CacheError('ERR_RANGE',
        `correction payload ${Buffer.isBuffer(data) ? data.length : 0} bytes != range ${end - start} bytes`);
    }
    const fd = fs.openSync(this.samplePath, 'r+');
    try { fs.writeSync(fd, data, 0, data.length, start); }
    finally { fs.closeSync(fd); }
    const bs = this.meta.blockSize;
    const s = Math.floor(start / bs);
    const e = Math.ceil(end / bs);
    for (let i = s; i < e; i++) {
      const b = this.meta.blocks[i];
      const chunk = this._readSourceRaw(i);
      b.crc = crc32(chunk);
      b.generation += 1;
      if (b.cached) {
        fs.writeFileSync(this._blockPath(i), chunk);
        this._touch(i);
      }
    }
    this._recomputeRoot();
    this._saveMeta();
    return { firstBlock: s, lastBlock: e - 1 };
  }

  certify(start, end) {
    this._requireMeta();
    const { s, e } = this._snapRange(start, end);
    const n = e - s;
    const generations = [];
    const leaves = [];
    for (let i = s; i < e; i++) {
      const b = this.meta.blocks[i];
      const { data } = this._readBlock(i);
      generations.push(b.generation);
      leaves.push(leafHash(i, b.generation, b.crc, data));
    }
    const cert = {
      type: CERT_TYPE,
      version: 1,
      sampleId: this.meta.sampleId,
      window: [s, e],
      generations,
      bitmap: fullBitmap(n).toString('hex'),
      root: merkleRoot(leaves).toString('hex'),
    };
    this._storeCert(cert);
    this._saveMeta();
    return cert;
  }

  checkCert(cert) {
    this._requireMeta();
    if (!cert || typeof cert !== 'object' || cert.type !== CERT_TYPE) {
      throw new CacheError('ERR_CRC', 'malformed certificate');
    }
    if (cert.sampleId !== this.meta.sampleId) {
      throw new CacheError('ERR_CRC', 'certificate was issued for a different sample');
    }
    const [s, e] = Array.isArray(cert.window) ? cert.window : [-1, -1];
    if (!Number.isInteger(s) || !Number.isInteger(e) ||
        s < 0 || e > this.meta.blockCount || s >= e) {
      throw new CacheError('ERR_RANGE',
        `certificate window [${s}, ${e}) outside block count ${this.meta.blockCount}`);
    }
    const n = e - s;
    if (!Array.isArray(cert.generations) || cert.generations.length !== n) {
      throw new CacheError('ERR_CRC', 'certificate generation vector does not match window');
    }
    const bitmap = Buffer.from(String(cert.bitmap || ''), 'hex');
    if (bitmap.length !== bitmapBytes(n)) {
      throw new CacheError('ERR_CRC', 'certificate bitmap does not match window');
    }
    const leaves = [];
    let covered = 0;
    let repaired = 0;
    for (let i = s; i < e; i++) {
      if (!getBit(bitmap, i - s)) continue;
      covered++;
      const b = this.meta.blocks[i];
      const r = this._readBlock(i);
      if (r.repaired) repaired++;
      if (b.generation !== cert.generations[i - s]) {
        throw new CacheError('ERR_STALE',
          `block ${i} generation ${b.generation} != certified ${cert.generations[i - s]}`);
      }
      leaves.push(leafHash(i, b.generation, b.crc, r.data));
    }
    if (!leaves.length) throw new CacheError('ERR_CRC', 'certificate covers no blocks');
    const root = merkleRoot(leaves).toString('hex');
    if (root !== cert.root) {
      throw new CacheError('ERR_CRC', 'certificate root does not match sample data');
    }
    this._saveMeta();
    return { ok: true, window: [s, e], covered, repaired, root };
  }

  invalidate(start, end) {
    this._requireMeta();
    const { s, e } = this._snapRange(start, end);
    let evicted = 0;
    for (let i = s; i < e; i++) {
      if (this.meta.blocks[i].cached) { this._evict(i); evicted++; }
    }
    const certs = this._loadCerts();
    const kept = certs.filter(c => c.window[1] <= s || c.window[0] >= e);
    this._saveCerts(kept);
    this._saveMeta();
    return { evictedBlocks: evicted, droppedCerts: certs.length - kept.length };
  }

  static canMerge(a, b) {
    if (!a || !b || a.sampleId !== b.sampleId) return false;
    const adjacent = a.window[1] === b.window[0] || b.window[1] === a.window[0];
    if (!adjacent) return false;
    const gens = a.generations.concat(b.generations);
    return gens.every(v => v === gens[0]);
  }

  mergeCerts(a, b) {
    this._requireMeta();
    if (!SampleCache.canMerge(a, b)) return null;
    const [left, right] = a.window[0] < b.window[0] ? [a, b] : [b, a];
    const n1 = left.window[1] - left.window[0];
    const n2 = right.window[1] - right.window[0];
    const generations = left.generations.concat(right.generations);
    const bitmap = concatBitmaps(
      Buffer.from(left.bitmap, 'hex'), n1,
      Buffer.from(right.bitmap, 'hex'), n2);
    const leaves = [];
    for (let i = left.window[0]; i < right.window[1]; i++) {
      if (!getBit(bitmap, i - left.window[0])) continue;
      const b = this.meta.blocks[i];
      const { data } = this._readBlock(i);
      leaves.push(leafHash(i, generations[i - left.window[0]], b.crc, data));
    }
    this._saveMeta();
    return {
      type: CERT_TYPE,
      version: 1,
      sampleId: left.sampleId,
      window: [left.window[0], right.window[1]],
      generations,
      bitmap: bitmap.toString('hex'),
      root: merkleRoot(leaves).toString('hex'),
    };
  }

  _storeCert(cert) {
    const certs = this._loadCerts();
    let candidate = cert;
    for (;;) {
      const idx = certs.findIndex(c => SampleCache.canMerge(c, candidate));
      if (idx < 0) break;
      candidate = this.mergeCerts(certs[idx], candidate);
      certs.splice(idx, 1);
    }
    certs.push(candidate);
    this._saveCerts(certs);
  }

  listCerts() {
    this._requireMeta();
    return this._loadCerts();
  }

  stats() {
    this._requireMeta();
    let cachedBlocks = 0;
    for (const b of this.meta.blocks) if (b.cached) cachedBlocks++;
    return {
      sample: this.samplePath,
      cacheDir: this.dir,
      size: this.meta.size,
      blockSize: this.meta.blockSize,
      blockCount: this.meta.blockCount,
      capacity: this.meta.capacity,
      cachedBytes: this._cachedBytes(),
      cachedBlocks,
      root: this.meta.root,
      storedCerts: this._loadCerts().length,
    };
  }
}

module.exports = { SampleCache, CacheError, CERT_TYPE };
