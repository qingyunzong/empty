'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest();
}

function blockDigest(generation, crc, data) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(generation >>> 0, 0);
  header.writeUInt32BE(crc >>> 0, 4);
  return sha256(Buffer.concat([header, data]));
}

function computeRoot(digests) {
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(digests.length, 0);
  return sha256(Buffer.concat([...digests, tail])).toString('hex');
}

class CacheError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CacheError';
    this.code = code;
  }
}

class SampleCache {
  constructor({ capacity = 8 * 1024 * 1024 } = {}) {
    if (!Number.isInteger(capacity) || capacity < 0) {
      throw new CacheError('ERR_RANGE', `invalid capacity: ${capacity}`);
    }
    this.capacity = capacity;
    this.samples = new Map();
    this.cache = new Map();
    this.usedBytes = 0;
  }

  _meta(id) {
    const meta = this.samples.get(id);
    if (!meta) throw new CacheError('ERR_RANGE', `unknown sample: ${id}`);
    return meta;
  }

  _checkRange(meta, start, end) {
    const ok = Number.isInteger(start) && Number.isInteger(end)
      && start >= 0 && end >= start && end < meta.blockCount;
    if (!ok) {
      throw new CacheError(
        'ERR_RANGE',
        `invalid block range [${start}, ${end}] for sample with ${meta.blockCount} blocks`,
      );
    }
  }

  _key(id, idx) {
    return `${id}:${idx}`;
  }

  _evictKey(key) {
    const entry = this.cache.get(key);
    if (entry) {
      this.cache.delete(key);
      this.usedBytes -= entry.bytes;
    }
  }

  _insert(key, data) {
    const bytes = data.length;
    if (bytes > this.capacity) return;
    while (this.usedBytes + bytes > this.capacity && this.cache.size > 0) {
      this._evictKey(this.cache.keys().next().value);
    }
    this.cache.set(key, { data, bytes });
    this.usedBytes += bytes;
  }

  _blockLength(meta, idx) {
    const start = idx * meta.chunkSize;
    return Math.min(meta.chunkSize, meta.size - start);
  }

  _readSourceBlock(meta, idx, { expectCurrentCrc = true } = {}) {
    const start = idx * meta.chunkSize;
    const len = this._blockLength(meta, idx);
    let fd = null;
    try {
      fd = fs.openSync(meta.sourcePath, 'r');
      const buf = Buffer.alloc(len);
      const got = fs.readSync(fd, buf, 0, len, start);
      fs.closeSync(fd);
      fd = null;
      if (got !== len) {
        throw new CacheError('ERR_SOURCE', `short read on source block ${idx}`);
      }
      if (expectCurrentCrc && crc32(buf) !== meta.crcs[idx]) {
        throw new CacheError('ERR_SOURCE', `source block ${idx} failed CRC check`);
      }
      return buf;
    } catch (err) {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
      }
      if (err instanceof CacheError) throw err;
      throw new CacheError('ERR_SOURCE', `cannot read source block ${idx}: ${err.message}`);
    }
  }

  _loadBlock(id, idx) {
    const meta = this._meta(id);
    const key = this._key(id, idx);
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      if (crc32(hit.data) === meta.crcs[idx]) {
        this.cache.set(key, hit);
        return hit.data;
      }
      this.usedBytes -= hit.bytes;
      const data = this._readSourceBlock(meta, idx);
      this._insert(key, data);
      return data;
    }
    const data = this._readSourceBlock(meta, idx);
    this._insert(key, data);
    return data;
  }

  ingest(id, sourcePath, { chunkSize = 4096 } = {}) {
    if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
      throw new CacheError('ERR_RANGE', `invalid chunk size: ${chunkSize}`);
    }
    let data;
    try {
      data = fs.readFileSync(sourcePath);
    } catch (err) {
      throw new CacheError('ERR_SOURCE', `cannot read source: ${err.message}`);
    }
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(`${id}:`)) this._evictKey(key);
    }
    const blockCount = Math.ceil(data.length / chunkSize);
    const generations = new Array(blockCount).fill(1);
    const crcs = new Array(blockCount);
    for (let idx = 0; idx < blockCount; idx += 1) {
      const start = idx * chunkSize;
      crcs[idx] = crc32(data.subarray(start, start + chunkSize));
    }
    this.samples.set(id, {
      id,
      sourcePath,
      chunkSize,
      size: data.length,
      blockCount,
      generations,
      crcs,
    });
    for (let idx = 0; idx < blockCount; idx += 1) {
      const start = idx * chunkSize;
      this._insert(this._key(id, idx), Buffer.from(data.subarray(start, start + chunkSize)));
    }
    return { sample: id, blockCount, size: data.length, chunkSize };
  }

  correctRange(id, start, end, { sourcePath } = {}) {
    const meta = this._meta(id);
    this._checkRange(meta, start, end);
    if (sourcePath) meta.sourcePath = sourcePath;
    let stat;
    try {
      stat = fs.statSync(meta.sourcePath);
    } catch (err) {
      throw new CacheError('ERR_SOURCE', `cannot stat source: ${err.message}`);
    }
    if (stat.size !== meta.size) {
      throw new CacheError('ERR_RANGE', 'source size changed; re-ingest required');
    }
    for (let idx = start; idx <= end; idx += 1) {
      const data = this._readSourceBlock(meta, idx, { expectCurrentCrc: false });
      meta.generations[idx] += 1;
      meta.crcs[idx] = crc32(data);
      const key = this._key(id, idx);
      if (this.cache.has(key)) {
        this._evictKey(key);
        this._insert(key, data);
      }
    }
    return { sample: id, corrected: end - start + 1 };
  }

  certify(id, start, end) {
    const meta = this._meta(id);
    this._checkRange(meta, start, end);
    const datas = [];
    const gens = [];
    for (let idx = start; idx <= end; idx += 1) {
      datas.push(this._loadBlock(id, idx));
      gens.push(meta.generations[idx]);
    }
    const generation = Math.max(...gens);
    const bitmapArr = gens.map((g) => (g === generation ? 1 : 0));
    const digests = [];
    for (let i = 0; i < gens.length; i += 1) {
      if (bitmapArr[i]) {
        digests.push(blockDigest(generation, meta.crcs[start + i], datas[i]).toString('hex'));
      }
    }
    return {
      version: 1,
      sample: id,
      window: { start, end },
      generation,
      bitmap: bitmapArr.join(''),
      digests,
      root: computeRoot(digests.map((hex) => Buffer.from(hex, 'hex'))),
    };
  }

  checkCert(id, cert) {
    const meta = this._meta(id);
    if (!cert || typeof cert !== 'object'
      || cert.version !== 1
      || typeof cert.sample !== 'string'
      || !cert.window || typeof cert.window !== 'object'
      || !Number.isInteger(cert.window.start) || !Number.isInteger(cert.window.end)
      || !Number.isInteger(cert.generation) || cert.generation < 1
      || typeof cert.bitmap !== 'string' || !/^[01]+$/.test(cert.bitmap)
      || !Array.isArray(cert.digests) || !cert.digests.every((d) => typeof d === 'string' && /^[0-9a-f]{64}$/.test(d))
      || typeof cert.root !== 'string' || !/^[0-9a-f]{64}$/.test(cert.root)) {
      throw new CacheError('ERR_CRC', 'malformed certificate');
    }
    if (cert.sample !== id) {
      throw new CacheError('ERR_RANGE', `certificate is for sample "${cert.sample}", not "${id}"`);
    }
    this._checkRange(meta, cert.window.start, cert.window.end);
    const { start, end } = cert.window;
    if (cert.bitmap.length !== end - start + 1) {
      throw new CacheError('ERR_CRC', 'bitmap length does not match window');
    }
    const covered = [];
    for (let i = 0; i < cert.bitmap.length; i += 1) {
      if (cert.bitmap[i] === '1') covered.push(start + i);
    }
    if (covered.length !== cert.digests.length) {
      throw new CacheError('ERR_CRC', 'digest count does not match bitmap');
    }
    for (let k = 0; k < covered.length; k += 1) {
      const idx = covered[k];
      if (meta.generations[idx] !== cert.generation) {
        throw new CacheError(
          'ERR_STALE',
          `block ${idx} is at generation ${meta.generations[idx]}, certificate expects ${cert.generation}`,
        );
      }
    }
    for (let k = 0; k < covered.length; k += 1) {
      const idx = covered[k];
      const data = this._loadBlock(id, idx);
      const digest = blockDigest(cert.generation, meta.crcs[idx], data).toString('hex');
      if (digest !== cert.digests[k]) {
        throw new CacheError('ERR_CRC', `block ${idx} digest mismatch`);
      }
    }
    const root = computeRoot(cert.digests.map((hex) => Buffer.from(hex, 'hex')));
    if (root !== cert.root) {
      throw new CacheError('ERR_CRC', 'certificate root mismatch');
    }
    return { ok: true, sample: id, covered: covered.length, generation: cert.generation };
  }

  invalidate(id, start, end) {
    const meta = this._meta(id);
    const lo = start === undefined ? 0 : start;
    const hi = end === undefined ? meta.blockCount - 1 : end;
    this._checkRange(meta, lo, hi);
    let removed = 0;
    for (let idx = lo; idx <= hi; idx += 1) {
      const key = this._key(id, idx);
      if (this.cache.has(key)) {
        this._evictKey(key);
        removed += 1;
      }
    }
    return { sample: id, invalidated: removed };
  }

  stats() {
    return {
      capacity: this.capacity,
      usedBytes: this.usedBytes,
      cachedBlocks: this.cache.size,
    };
  }
}

function mergeCertificates(certs) {
  if (!Array.isArray(certs)) {
    throw new CacheError('ERR_CRC', 'certificates must be an array');
  }
  const sorted = certs.map((c) => ({
    ...c,
    window: { ...c.window },
    digests: [...c.digests],
  })).sort((a, b) => a.window.start - b.window.start);
  const out = [];
  for (const cert of sorted) {
    const last = out[out.length - 1];
    if (last && last.sample === cert.sample
      && last.window.end + 1 === cert.window.start
      && last.generation === cert.generation) {
      last.window.end = cert.window.end;
      last.bitmap += cert.bitmap;
      last.digests.push(...cert.digests);
      last.root = computeRoot(last.digests.map((hex) => Buffer.from(hex, 'hex')));
    } else {
      out.push(cert);
    }
  }
  return out;
}

module.exports = {
  SampleCache,
  CacheError,
  mergeCertificates,
  crc32,
  blockDigest,
  computeRoot,
};
