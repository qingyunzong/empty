'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');

const GENESIS = '0'.repeat(64);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(str) {
  const buf = Buffer.from(str, 'utf8');
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}

class LogError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'LogError';
    this.code = code;
  }
}

function canonicalBody(f) {
  return JSON.stringify({
    seq: f.seq,
    type: f.type,
    id: f.id,
    ts: f.ts,
    value: f.value === undefined ? null : f.value,
    quality: f.quality === undefined ? null : f.quality,
    ref: f.ref === undefined ? null : f.ref,
    prevHash: f.prevHash,
  });
}

function computeCrc(f) {
  return crc32(canonicalBody(f));
}

function frameHash(f) {
  return crypto.createHash('sha256').update(canonicalBody(f) + '|' + f.crc).digest('hex');
}

function cmpFrames(a, b) {
  return a.ts - b.ts || a.seq - b.seq;
}

class Log {
  constructor(path) {
    this.path = path;
    this.frames = [];
    this.byId = new Map();
    this.reload();
  }

  reload() {
    this.frames = [];
    this.byId = new Map();
    if (!fs.existsSync(this.path)) return;
    const lines = fs.readFileSync(this.path, 'utf8').split('\n').filter((l) => l.trim() !== '');
    let prev = GENESIS;
    for (const line of lines) {
      const f = JSON.parse(line);
      if (f.crc !== computeCrc(f)) {
        throw new LogError('ERR_CRC', `crc mismatch at seq ${f.seq}`);
      }
      const hash = frameHash(f);
      if (f.prevHash !== prev) {
        throw new LogError('ERR_CHAIN', `broken chain at seq ${f.seq}`);
      }
      prev = hash;
      this.frames.push(f);
      let entry = this.byId.get(f.id);
      if (!entry) {
        entry = [];
        this.byId.set(f.id, entry);
      }
      entry.push(f);
    }
    for (const entry of this.byId.values()) entry.sort(cmpFrames);
  }

  verify() {
    this.reload();
    return { ok: true, frames: this.frames.length };
  }

  latestFrame(id) {
    const entry = this.byId.get(id);
    if (!entry || entry.length === 0) return null;
    return entry[entry.length - 1];
  }

  _append(fields) {
    const seq = this.frames.length;
    const prevHash = seq === 0 ? GENESIS : frameHash(this.frames[seq - 1]);
    const f = {
      seq,
      type: fields.type,
      id: fields.id,
      ts: fields.ts,
      value: fields.value === undefined ? null : fields.value,
      quality: fields.quality === undefined ? null : fields.quality,
      ref: fields.ref === undefined ? null : fields.ref,
      prevHash,
    };
    f.crc = computeCrc(f);
    f.hash = frameHash(f);
    fs.appendFileSync(this.path, JSON.stringify(f) + '\n');
    this.frames.push(f);
    let entry = this.byId.get(f.id);
    if (!entry) {
      entry = [];
      this.byId.set(f.id, entry);
    }
    entry.push(f);
    entry.sort(cmpFrames);
    return f;
  }

  appendObs(id, ts, value, quality) {
    return this._append({ type: 'OBS', id, ts, value, quality: quality === undefined ? 'ok' : quality });
  }

  flag(id, quality, ts) {
    const latest = this.latestFrame(id);
    if (!latest) throw new LogError('ERR_NOTFOUND', `unknown id ${id}`);
    if (latest.type === 'TOMB') throw new LogError('ERR_STALE', `id ${id} is invalidated`);
    return this._append({
      type: 'FLAG',
      id,
      ts: ts === undefined ? Date.now() : ts,
      quality,
      ref: latest.hash,
    });
  }

  invalidate(id, ts) {
    const latest = this.latestFrame(id);
    if (!latest) throw new LogError('ERR_NOTFOUND', `unknown id ${id}`);
    if (latest.type === 'TOMB') throw new LogError('ERR_STALE', `id ${id} already invalidated`);
    return this._append({
      type: 'TOMB',
      id,
      ts: ts === undefined ? Date.now() : ts,
      ref: latest.hash,
    });
  }

  current(id) {
    const entry = this.byId.get(id);
    if (!entry) throw new LogError('ERR_NOTFOUND', `unknown id ${id}`);
    let state = null;
    for (const f of entry) {
      if (f.type === 'OBS') {
        state = { id, value: f.value, quality: f.quality, ts: f.ts };
      } else if (f.type === 'FLAG') {
        if (state) state.quality = f.quality;
      } else if (f.type === 'TOMB') {
        state = null;
      }
    }
    if (!state) throw new LogError('ERR_NOTFOUND', `id ${id} has no current value`);
    return state;
  }

  history(id) {
    const entry = this.byId.get(id);
    if (!entry) throw new LogError('ERR_NOTFOUND', `unknown id ${id}`);
    return entry.map((f) => ({
      seq: f.seq,
      type: f.type,
      ts: f.ts,
      value: f.value,
      quality: f.quality,
      ref: f.ref,
    }));
  }
}

module.exports = { Log, LogError, GENESIS };
