'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const codec = require('./codec');
const { LogError } = require('./errors');

const FILE_MAGIC = Buffer.from('DLOG0001');
const FOOTER_MAGIC = Buffer.from('DLOGEND1');
const FOOTER_LEN = 16; // u64 indexOffset + 8-byte magic
const AUTO_FLUSH_RECORDS = 64;

function toBuffer(payload) {
  if (payload === undefined || payload === null) return Buffer.alloc(0);
  if (Buffer.isBuffer(payload)) return payload;
  return Buffer.from(String(payload), 'utf8');
}

function canonicalRecord(r) {
  const o = { type: r.type, seq: r.seq, ts: r.ts };
  if (r.type === 'event') {
    o.device = r.device;
    o.status = r.status;
    o.payload = r.payload.toString('hex');
  } else if (r.type === 'correction') {
    o.status = r.status;
    o.payload = r.payload.toString('hex');
    o.refSeq = r.refSeq;
    o.reason = r.reason;
  } else {
    o.refSeq = r.refSeq;
    o.reason = r.reason;
  }
  return JSON.stringify(o);
}

function hashRecord(r) {
  return crypto.createHash('sha256').update(canonicalRecord(r)).digest('hex');
}

function makeCertificate(original, correction) {
  return {
    version: 1,
    type: correction.type,
    refSeq: correction.refSeq,
    activeSeq: correction.seq,
    originalHash: hashRecord(original),
    correctionHash: hashRecord(correction),
  };
}

// Fold a record stream into the active view. Independent of storage layout.
function foldView(records) {
  const baseline = new Map();
  const view = new Map();
  const dead = new Set();
  for (const r of records) {
    if (r.type === 'event') {
      const entry = {
        seq: r.seq,
        ts: r.ts,
        device: r.device,
        status: r.status,
        payload: r.payload,
        corrections: [],
      };
      baseline.set(r.seq, entry);
      view.set(r.seq, entry);
    } else if (r.type === 'correction') {
      if (!baseline.has(r.refSeq)) {
        throw new LogError('E_REVISION', `correction ${r.seq} references missing event ${r.refSeq}`);
      }
      const cur = view.get(r.refSeq);
      if (cur && !dead.has(r.refSeq)) {
        cur.status = r.status;
        cur.payload = r.payload;
        cur.corrections.push(r.seq);
      }
    } else {
      if (!baseline.has(r.refSeq)) {
        throw new LogError('E_REVISION', `tombstone ${r.seq} references missing event ${r.refSeq}`);
      }
      dead.add(r.refSeq);
      view.delete(r.refSeq);
    }
  }
  return [...view.values()].sort((a, b) => a.seq - b.seq);
}

class EventLog {
  static open(file) {
    return new EventLog(file);
  }

  constructor(file) {
    this.file = file;
    this._pending = [];
    this._error = null;
    this._load();
  }

  _load() {
    if (!fs.existsSync(this.file) || fs.statSync(this.file).size === 0) {
      const fd = fs.openSync(this.file, 'w');
      const index = codec.encodeIndex([]);
      fs.writeSync(fd, FILE_MAGIC);
      fs.writeSync(fd, index);
      fs.writeSync(fd, this._encodeFooter(FILE_MAGIC.length));
      fs.closeSync(fd);
    }
    const buf = fs.readFileSync(this.file);
    if (buf.length < FILE_MAGIC.length + FOOTER_LEN || !buf.subarray(0, 8).equals(FILE_MAGIC)) {
      throw new LogError('E_FORMAT', 'bad file magic');
    }
    let entries = null;
    const footerOff = buf.length - FOOTER_LEN;
    if (buf.subarray(footerOff + 8, footerOff + 16).equals(FOOTER_MAGIC)) {
      const indexOffset = Number(buf.readBigUInt64LE(footerOff));
      try {
        entries = codec.decodeIndex(buf, indexOffset);
      } catch {
        entries = null;
      }
    }
    if (entries === null) {
      // Index missing/corrupt: full scan rebuild.
      this._rebuild();
      return;
    }
    this._index = new Map(entries.map((e) => [e.seq, e.offset]));
    this._refresh();
  }

  _encodeFooter(indexOffset) {
    const footer = Buffer.alloc(FOOTER_LEN);
    footer.writeBigUInt64LE(BigInt(indexOffset), 0);
    FOOTER_MAGIC.copy(footer, 8);
    return footer;
  }

  // Sequentially decode every block. Blocks apply atomically: on E_CRC the
  // thrown error carries the records of all complete preceding blocks.
  _scan(buf) {
    const records = [];
    const scannedIndex = new Map();
    let offset = FILE_MAGIC.length;
    while (offset + codec.BLOCK_HEADER_LEN <= buf.length && buf.readUInt32LE(offset) === codec.BLOCK_MAGIC) {
      let decoded;
      try {
        decoded = codec.decodeBlock(buf, offset);
      } catch (err) {
        if (err instanceof LogError && err.code === 'E_CRC') {
          err.records = records;
          err.blockOffset = offset;
        }
        throw err;
      }
      for (const r of decoded.records) scannedIndex.set(r.seq, offset);
      records.push(...decoded.records);
      offset = decoded.nextOffset;
    }
    this._records = records;
    this._scannedIndex = scannedIndex;
    this._endOffset = offset;
    this._lastSeq = records.length ? records[records.length - 1].seq : 0;
    this._eventSeqs = new Set(records.filter((r) => r.type === 'event').map((r) => r.seq));
    this._error = null;
  }

  _refresh() {
    const buf = fs.readFileSync(this.file);
    try {
      this._scan(buf);
    } catch (err) {
      if (err instanceof LogError && err.code === 'E_CRC') {
        // Degraded mode: keep the intact prefix, block all writes.
        const partial = err.records || [];
        this._records = partial;
        this._lastSeq = partial.length ? partial[partial.length - 1].seq : 0;
        this._eventSeqs = new Set(partial.filter((r) => r.type === 'event').map((r) => r.seq));
        this._error = err;
        return;
      }
      throw err;
    }
  }

  _rebuild() {
    const buf = fs.readFileSync(this.file);
    this._scan(buf); // throws E_CRC if a data block is corrupt
    const entries = [...this._scannedIndex.entries()].map(([seq, offset]) => ({ seq, offset }));
    const index = codec.encodeIndex(entries);
    const fd = fs.openSync(this.file, 'r+');
    try {
      fs.ftruncateSync(fd, this._endOffset);
      fs.writeSync(fd, index, 0, index.length, this._endOffset);
      fs.writeSync(fd, this._encodeFooter(this._endOffset), 0, FOOTER_LEN, this._endOffset + index.length);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this._index = this._scannedIndex;
  }

  rebuildIndex() {
    this._rebuild();
    this._refresh();
    return { entries: this._index.size };
  }

  _checkHealthy() {
    if (this._error) throw this._error;
  }

  _assertRef(refSeq) {
    if (this._eventSeqs.has(refSeq)) return;
    if (this._pending.some((r) => r.type === 'event' && r.seq === refSeq)) return;
    throw new LogError('E_REVISION', `referenced event ${refSeq} does not exist`);
  }

  _nextSeq() {
    return this._lastSeq + 1;
  }

  _push(rec) {
    this._pending.push(rec);
    this._lastSeq = rec.seq;
    if (rec.type === 'event') this._eventSeqs.add(rec.seq);
    if (this._pending.length >= AUTO_FLUSH_RECORDS) this.flush();
    return rec;
  }

  append({ device, status = 0, payload, ts }) {
    this._checkHealthy();
    if (typeof device !== 'string' || device.length === 0) {
      throw new LogError('E_USAGE', 'device is required');
    }
    const rec = {
      type: 'event',
      seq: this._nextSeq(),
      ts: ts ?? Date.now(),
      device,
      status,
      payload: toBuffer(payload),
    };
    this._push(rec);
    return rec.seq;
  }

  correct(refSeq, { reason, status = 0, payload, ts } = {}) {
    this._checkHealthy();
    if (!reason) throw new LogError('E_USAGE', 'correction reason is required');
    this._assertRef(refSeq);
    const rec = {
      type: 'correction',
      seq: this._nextSeq(),
      ts: ts ?? Date.now(),
      status,
      payload: toBuffer(payload),
      refSeq,
      reason,
    };
    this._push(rec);
    const original = this._findRecord(refSeq);
    return { seq: rec.seq, certificate: makeCertificate(original, rec) };
  }

  revoke(refSeq, { reason, ts } = {}) {
    this._checkHealthy();
    if (!reason) throw new LogError('E_USAGE', 'tombstone reason is required');
    this._assertRef(refSeq);
    const rec = {
      type: 'tombstone',
      seq: this._nextSeq(),
      ts: ts ?? Date.now(),
      refSeq,
      reason,
    };
    this._push(rec);
    const original = this._findRecord(refSeq);
    return { seq: rec.seq, certificate: makeCertificate(original, rec) };
  }

  _findRecord(seq) {
    const rec = this._records.find((r) => r.seq === seq) || this._pending.find((r) => r.seq === seq);
    if (!rec) throw new LogError('E_REVISION', `record ${seq} does not exist`);
    return rec;
  }

  flush() {
    this._checkHealthy();
    if (this._pending.length === 0) return;
    // Validate on-disk state before writing anything; a corrupt tail aborts
    // the flush so no half-updated state is ever produced.
    const buf = fs.readFileSync(this.file);
    this._scan(buf);
    const block = codec.encodeBlock(this._pending);
    for (const r of this._pending) this._scannedIndex.set(r.seq, this._endOffset);
    const entries = [...this._scannedIndex.entries()].map(([seq, offset]) => ({ seq, offset }));
    const index = codec.encodeIndex(entries);
    const indexOffset = this._endOffset + block.length;
    const fd = fs.openSync(this.file, 'r+');
    try {
      fs.writeSync(fd, block, 0, block.length, this._endOffset);
      fs.writeSync(fd, index, 0, index.length, indexOffset);
      fs.writeSync(fd, this._encodeFooter(indexOffset), 0, FOOTER_LEN, indexOffset + index.length);
      fs.ftruncateSync(fd, indexOffset + index.length + FOOTER_LEN);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this._records.push(...this._pending);
    // _scan above reset in-memory bookkeeping to the on-disk prefix; re-apply
    // the just-flushed records so seq allocation and ref checks stay correct.
    for (const r of this._pending) {
      this._lastSeq = r.seq;
      if (r.type === 'event') this._eventSeqs.add(r.seq);
    }
    this._pending = [];
    this._endOffset = indexOffset;
    this._index = this._scannedIndex;
  }

  _allRecords() {
    return [...this._records, ...this._pending];
  }

  view() {
    this._refresh();
    this._checkHealthy();
    return foldView(this._allRecords());
  }

  // Tolerant read: returns the view of all intact blocks plus the error.
  safeView() {
    this._refresh();
    return { view: foldView(this._allRecords()), error: this._error };
  }

  audit() {
    this._refresh();
    this._checkHealthy();
    return this._allRecords().map((r) => ({ ...r, hash: hashRecord(r) }));
  }

  getRecord(seq) {
    const pending = this._pending.find((r) => r.seq === seq);
    if (pending) return pending;
    const offset = this._index.get(seq);
    if (offset === undefined) return null;
    const buf = fs.readFileSync(this.file);
    const { records } = codec.decodeBlock(buf, offset);
    return records.find((r) => r.seq === seq) ?? null;
  }

  verifyCertificate(cert) {
    if (!cert || typeof cert !== 'object') return false;
    this._refresh();
    if (this._error) return false;
    const all = this._allRecords();
    const original = all.find((r) => r.seq === cert.refSeq);
    const correction = all.find((r) => r.seq === cert.activeSeq && r.type !== 'event');
    if (!original || !correction) return false;
    if (correction.refSeq !== cert.refSeq) return false;
    if (correction.type !== cert.type) return false;
    return hashRecord(original) === cert.originalHash && hashRecord(correction) === cert.correctionHash;
  }

  close() {
    this.flush();
  }
}

module.exports = { EventLog, LogError, foldView, hashRecord, FILE_MAGIC, FOOTER_MAGIC, FOOTER_LEN };
