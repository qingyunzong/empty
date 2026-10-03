'use strict';

// Append-only sensor observation log with hash-chained, CRC-protected frames.
// Frame types: OBS (observation), FLAG (quality review), TOMB (invalidation).
// Standard library only.

const fs = require('fs');
const crypto = require('crypto');

const GENESIS = '0'.repeat(64);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(str) {
  let c = 0xffffffff;
  const buf = Buffer.from(str, 'utf8');
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return ((c ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}

function sha256(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

// Deterministic serialization: fixed key order.
function canonical(frame, withCrc) {
  const obj = {
    seq: frame.seq,
    type: frame.type,
    id: frame.id,
    ts: frame.ts,
    value: frame.value,
    quality: frame.quality,
    ref: frame.ref,
    prevHash: frame.prevHash,
  };
  if (withCrc) obj.crc = frame.crc;
  return JSON.stringify(obj);
}

function frameCrc(frame) {
  return crc32(canonical(frame, false));
}

function frameHash(frame) {
  return sha256(canonical(frame, true));
}

class StoreError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

// Ordering key: (ts, seq). Same id + same ts -> higher frame seq wins.
function cmpFrames(a, b) {
  if (a.ts !== b.ts) return a.ts - b.ts;
  return a.seq - b.seq;
}

class Store {
  constructor(path) {
    this.path = path;
    this.frames = [];
    this.index = new Map(); // id -> array of frames (append order)
    this._load();
  }

  _load() {
    if (!fs.existsSync(this.path)) return;
    const lines = fs.readFileSync(this.path, 'utf8').split('\n').filter((l) => l.length > 0);
    for (const line of lines) this._indexFrame(JSON.parse(line));
    this.frames.sort((a, b) => a.seq - b.seq);
  }

  _indexFrame(frame) {
    this.frames.push(frame);
    let list = this.index.get(frame.id);
    if (!list) {
      list = [];
      this.index.set(frame.id, list);
    }
    list.push(frame);
  }

  _append(type, id, ts, value, quality, ref) {
    const frame = {
      seq: this.frames.length,
      type,
      id,
      ts,
      value,
      quality,
      ref,
      prevHash: this.frames.length ? frameHash(this.frames[this.frames.length - 1]) : GENESIS,
    };
    frame.crc = frameCrc(frame);
    frame.hash = frameHash(frame);
    fs.appendFileSync(this.path, JSON.stringify(frame) + '\n');
    this._indexFrame(frame);
    return frame;
  }

  _latest(id) {
    const list = this.index.get(id);
    if (!list || list.length === 0) return null;
    let best = list[0];
    for (const f of list) if (cmpFrames(f, best) > 0) best = f;
    return best;
  }

  appendObs(id, ts, value) {
    return this._append('OBS', id, ts, value, 'OK', null);
  }

  // ref must be the hash of the id's current latest frame, else ERR_STALE.
  flag(id, ref, quality) {
    const latest = this._latest(id);
    if (!latest) throw new StoreError('ERR_NOTFOUND');
    if (latest.type === 'TOMB' || latest.hash !== ref) throw new StoreError('ERR_STALE');
    return this._append('FLAG', id, latest.ts, null, quality, ref);
  }

  invalidate(id) {
    const latest = this._latest(id);
    if (!latest) throw new StoreError('ERR_NOTFOUND');
    return this._append('TOMB', id, latest.ts, null, null, latest.hash);
  }

  current(id) {
    const list = this.index.get(id);
    if (!list || list.length === 0) throw new StoreError('ERR_NOTFOUND');
    const latest = this._latest(id);
    if (latest.type === 'TOMB') throw new StoreError('ERR_NOTFOUND');
    const sorted = list.filter((f) => cmpFrames(f, latest) <= 0).sort(cmpFrames);
    let state = null;
    for (const f of sorted) {
      if (f.type === 'OBS') state = { id: f.id, ts: f.ts, value: f.value, quality: f.quality };
      else if (f.type === 'FLAG' && state) state.quality = f.quality;
    }
    if (!state) throw new StoreError('ERR_NOTFOUND');
    state.seq = latest.seq;
    state.hash = latest.hash;
    return state;
  }

  history(id) {
    const list = this.index.get(id);
    if (!list || list.length === 0) throw new StoreError('ERR_NOTFOUND');
    return list.slice().sort(cmpFrames).map((f) => ({
      seq: f.seq, type: f.type, id: f.id, ts: f.ts,
      value: f.value, quality: f.quality, ref: f.ref, hash: f.hash,
    }));
  }

  // Re-scan the log file from disk and validate CRC + hash chain.
  verify() {
    if (!fs.existsSync(this.path)) return { ok: true, frames: 0 };
    const lines = fs.readFileSync(this.path, 'utf8').split('\n').filter((l) => l.length > 0);
    let prevHash = GENESIS;
    let count = 0;
    for (const line of lines) {
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        throw new StoreError('ERR_CRC');
      }
      if (frame.crc !== frameCrc(frame)) throw new StoreError('ERR_CRC');
      if (frame.hash !== frameHash(frame)) throw new StoreError('ERR_CRC');
      if (frame.prevHash !== prevHash) throw new StoreError('ERR_CHAIN');
      prevHash = frame.hash;
      count++;
    }
    return { ok: true, frames: count };
  }

  // Drop the in-memory index and rebuild it by scanning the log.
  rebuild() {
    this.frames = [];
    this.index = new Map();
    this._load();
    return { ok: true, frames: this.frames.length };
  }
}

module.exports = { Store, StoreError, crc32, frameCrc, frameHash, canonical, GENESIS };
