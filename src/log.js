import fs from 'node:fs';
import {
  HEADER,
  RECORD_TYPE,
  encodeBlock,
  decodeBlock,
  encodeIndex,
  decodeIndex,
} from './format.js';
import { LogError, E_CRC, E_REVISION, E_FORMAT } from './errors.js';

const DEFAULT_BLOCK_SIZE = 16;

// Append-only event log. Records are buffered and flushed as CRC32-protected
// blocks; a tail index (seq -> block offset) is rewritten on every flush.
export class EventLog {
  static open(path, options = {}) {
    return new EventLog(path, options);
  }

  constructor(path, { blockSize = DEFAULT_BLOCK_SIZE } = {}) {
    if (!Number.isInteger(blockSize) || blockSize < 1) {
      throw new LogError(E_FORMAT, 'blockSize must be a positive integer');
    }
    this.path = path;
    this.blockSize = blockSize;
    this.pending = [];
    this.index = new Map(); // seq -> { offset, type }
    this.maxSeq = 0;

    if (!fs.existsSync(path) || fs.statSync(path).size === 0) {
      fs.writeFileSync(path, HEADER);
    }
    this.fd = fs.openSync(path, 'r+');
    this.#load();
  }

  #load() {
    const buf = fs.readFileSync(this.path);
    if (buf.length < HEADER.length || !buf.subarray(0, HEADER.length).equals(HEADER)) {
      throw new LogError(E_FORMAT, 'not an EVL1 log file');
    }
    const decoded = decodeIndex(buf);
    if (decoded) {
      this.index = decoded.entries;
      this.dataEnd = decoded.indexStart;
    } else {
      this.#rebuildIndex(buf);
    }
    for (const seq of this.index.keys()) {
      if (seq > this.maxSeq) this.maxSeq = seq;
    }
  }

  // Full scan rebuild used when the tail index is missing or corrupt.
  #rebuildIndex(buf) {
    const entries = new Map();
    let offset = HEADER.length;
    while (offset < buf.length) {
      let block;
      try {
        block = decodeBlock(buf, offset);
      } catch (err) {
        if (err.code === E_CRC) throw err;
        if (err.code === 'E_TRUNCATED' || err.code === E_FORMAT) break; // torn tail: stop scan
        throw err;
      }
      for (const rec of block.records) {
        entries.set(rec.seq, { offset, type: rec.type });
      }
      offset += block.size;
    }
    this.index = entries;
    this.dataEnd = offset;
    this.#rewriteTail();
  }

  // Truncates the file back to dataEnd and appends the current index.
  #rewriteTail() {
    const entries = [...this.index.entries()].sort((a, b) => a[0] - b[0]);
    const indexBuf = encodeIndex(entries);
    fs.ftruncateSync(this.fd, this.dataEnd);
    fs.writeSync(this.fd, indexBuf, 0, indexBuf.length, this.dataEnd);
    fs.fsyncSync(this.fd);
  }

  get nextSeq() {
    return this.maxSeq + 1;
  }

  hasEvent(seq) {
    const entry = this.index.get(seq);
    if (entry !== undefined) return entry.type === RECORD_TYPE.EVENT;
    const pending = this.pending.find((rec) => rec.seq === seq);
    return pending !== undefined && pending.type === RECORD_TYPE.EVENT;
  }

  append({ device, status, payload = '', ts } = {}) {
    if (typeof device !== 'string' || device.length === 0) {
      throw new LogError(E_FORMAT, 'device is required');
    }
    if (!Number.isInteger(status)) {
      throw new LogError(E_FORMAT, 'status must be an integer');
    }
    const rec = {
      type: RECORD_TYPE.EVENT,
      seq: this.nextSeq,
      ts: normalizeTs(ts),
      device,
      status,
      payload: toBuffer(payload),
    };
    return this.#push(rec);
  }

  correct({ seq: refSeq, reason, device, status, payload, ts } = {}) {
    this.#checkRevision(refSeq, reason);
    const rec = {
      type: RECORD_TYPE.CORRECTION,
      seq: this.nextSeq,
      ts: normalizeTs(ts),
      refSeq,
      reason,
    };
    if (device !== undefined) rec.device = device;
    if (status !== undefined) rec.status = status;
    if (payload !== undefined) rec.payload = toBuffer(payload);
    if (rec.device === undefined && rec.status === undefined && rec.payload === undefined) {
      throw new LogError(E_FORMAT, 'correction must change at least one field');
    }
    return this.#push(rec);
  }

  revoke({ seq: refSeq, reason, ts } = {}) {
    this.#checkRevision(refSeq, reason);
    const rec = {
      type: RECORD_TYPE.TOMBSTONE,
      seq: this.nextSeq,
      ts: normalizeTs(ts),
      refSeq,
      reason,
    };
    return this.#push(rec);
  }

  #checkRevision(refSeq, reason) {
    if (!Number.isInteger(refSeq) || !this.hasEvent(refSeq)) {
      throw new LogError(E_REVISION, `no event with seq ${refSeq}`);
    }
    if (typeof reason !== 'string' || reason.length === 0) {
      throw new LogError(E_FORMAT, 'reason is required');
    }
  }

  #push(rec) {
    this.pending.push(rec);
    this.maxSeq = rec.seq;
    if (this.pending.length >= this.blockSize) this.flush();
    return rec.seq;
  }

  flush() {
    if (this.pending.length === 0) return;
    const block = encodeBlock(this.pending);
    fs.ftruncateSync(this.fd, this.dataEnd);
    fs.writeSync(this.fd, block, 0, block.length, this.dataEnd);
    for (const rec of this.pending) {
      this.index.set(rec.seq, { offset: this.dataEnd, type: rec.type });
    }
    this.dataEnd += block.length;
    this.pending = [];
    this.#rewriteTail();
  }

  close() {
    this.flush();
    fs.closeSync(this.fd);
  }
}

function normalizeTs(ts) {
  if (ts === undefined) return Date.now();
  if (!Number.isInteger(ts)) throw new LogError(E_FORMAT, 'ts must be an integer (ms)');
  return ts;
}

function toBuffer(payload) {
  if (Buffer.isBuffer(payload)) return payload;
  return Buffer.from(String(payload), 'utf8');
}
