import fs from 'node:fs';
import path from 'node:path';
import { crc32 } from './crc32.js';

// On-disk layout:
//   <dir>/manifest.json          readable segment list, updated via tmp + rename
//   <dir>/manifest.json.tmp      crash-recoverable staging file
//   <dir>/segments/seg-NNNN.seg  fixed-size segment files
//   <dir>/index.json             materialized index snapshot (rebuilt on open)
//
// Segment: 16-byte header + fixed-size records, zero padded to segmentSize.
//   header: magic(4) version(1) count(uint32le) crc32(uint32le of used body) reserved(3)
// Record (80 bytes):
//   device(16, utf8 nul-padded) seq(uint64le) severity(uint8)
//   ts(int64le ms) message(47, utf8 nul-padded)

export const MAGIC = Buffer.from('ALSE');
export const VERSION = 1;
export const HEADER_SIZE = 16;
export const RECORD_SIZE = 80;
export const DEVICE_LEN = 16;
export const MESSAGE_LEN = 47;
export const DEFAULT_SEGMENT_SIZE = 4096;
export const DEFAULT_MAX_SEGMENTS = 8;

export class AlertError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AlertError';
    this.code = code;
    Object.assign(this, details);
  }
}

export function segmentName(id) {
  return `seg-${String(id).padStart(8, '0')}.seg`;
}

export function segmentCapacity(segmentSize) {
  return Math.floor((segmentSize - HEADER_SIZE) / RECORD_SIZE);
}

export function encodeRecord(rec) {
  const buf = Buffer.alloc(RECORD_SIZE);
  const dev = Buffer.from(rec.device, 'utf8');
  if (dev.length > DEVICE_LEN) {
    throw new AlertError('E_DEVICE', `device id too long (max ${DEVICE_LEN} bytes): ${rec.device}`);
  }
  dev.copy(buf, 0);
  buf.writeBigUInt64LE(BigInt(rec.seq), 16);
  buf.writeUInt8(Number(rec.severity) & 0xff, 24);
  buf.writeBigInt64LE(BigInt(rec.ts ?? 0), 25);
  Buffer.from(rec.message ?? '', 'utf8').subarray(0, MESSAGE_LEN).copy(buf, 33);
  return buf;
}

export function decodeRecord(buf, offset = 0) {
  let dend = buf.indexOf(0, offset);
  if (dend === -1 || dend > offset + DEVICE_LEN) dend = offset + DEVICE_LEN;
  let mend = buf.indexOf(0, offset + 33);
  if (mend === -1 || mend > offset + RECORD_SIZE) mend = offset + RECORD_SIZE;
  return {
    device: buf.toString('utf8', offset, dend),
    seq: buf.readBigUInt64LE(offset + 16),
    severity: buf.readUInt8(offset + 24),
    ts: buf.readBigInt64LE(offset + 25),
    message: buf.toString('utf8', offset + 33, mend),
  };
}

export function buildSegmentBuffer(records, segmentSize = DEFAULT_SEGMENT_SIZE) {
  if (records.length > segmentCapacity(segmentSize)) {
    throw new AlertError('E_SEGMENT', `too many records for segment of ${segmentSize} bytes`);
  }
  const buf = Buffer.alloc(segmentSize);
  MAGIC.copy(buf, 0);
  buf.writeUInt8(VERSION, 4);
  buf.writeUInt32LE(records.length, 5);
  let off = HEADER_SIZE;
  for (const rec of records) {
    encodeRecord(rec).copy(buf, off);
    off += RECORD_SIZE;
  }
  buf.writeUInt32LE(crc32(buf.subarray(HEADER_SIZE, off)), 9);
  return buf;
}

export function parseSegment(buf, file = 'segment') {
  if (buf.length < HEADER_SIZE || !buf.subarray(0, 4).equals(MAGIC)) {
    throw new AlertError('E_FORMAT', `bad segment magic in ${file}`);
  }
  const count = buf.readUInt32LE(5);
  const expectedCrc = buf.readUInt32LE(9);
  const bodyLen = count * RECORD_SIZE;
  if (HEADER_SIZE + bodyLen > buf.length) {
    throw new AlertError('E_FORMAT', `truncated segment ${file}`);
  }
  const actualCrc = crc32(buf.subarray(HEADER_SIZE, HEADER_SIZE + bodyLen));
  if (actualCrc !== expectedCrc) {
    throw new AlertError('E_CRC', `crc32 mismatch in ${file}: stored ${expectedCrc.toString(16)}, computed ${actualCrc.toString(16)}`);
  }
  const records = [];
  for (let i = 0; i < count; i++) {
    const offset = HEADER_SIZE + i * RECORD_SIZE;
    records.push({ offset, rec: decodeRecord(buf, offset) });
  }
  return records;
}

export function encodeCursor(cursor) {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeCursor(token) {
  try {
    const cursor = JSON.parse(Buffer.from(String(token), 'base64url').toString('utf8'));
    if (typeof cursor !== 'object' || cursor === null || typeof cursor.devices !== 'object') {
      throw new Error('bad shape');
    }
    return cursor;
  } catch {
    throw new AlertError('E_CURSOR', 'invalid cursor token');
  }
}

function fsyncDir(dir) {
  try {
    const fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
  } catch {
    // best effort
  }
}

export class AlertStore {
  constructor(dir, opts = {}) {
    this.dir = dir;
    this.segmentSize = opts.segmentSize ?? DEFAULT_SEGMENT_SIZE;
    this.maxSegments = opts.maxSegments ?? DEFAULT_MAX_SEGMENTS;
    if (segmentCapacity(this.segmentSize) < 1) {
      throw new AlertError('E_CONFIG', `segmentSize ${this.segmentSize} fits no records`);
    }
    this.segDir = path.join(dir, 'segments');
    this.manifestPath = path.join(dir, 'manifest.json');
    this.manifestTmpPath = this.manifestPath + '.tmp';
    this.indexPath = path.join(dir, 'index.json');
    this.devices = new Map();      // device -> { minSeq, maxSeq, records: [{seq, segment, offset, rec}] }
    this.duplicates = 0;
    this.dedupCounts = new Map();  // "device:seq" -> duplicate count
    this._segmentRecords = new Map();
    this._active = null;
    this._open();
  }

  _open() {
    fs.mkdirSync(this.segDir, { recursive: true });
    if (fs.existsSync(this.manifestPath)) {
      this.manifest = JSON.parse(fs.readFileSync(this.manifestPath, 'utf8'));
    } else {
      this.manifest = { version: VERSION, segments: [], nextSegmentId: 1 };
    }
    for (const name of this.manifest.segments) {
      const entries = parseSegment(fs.readFileSync(path.join(this.segDir, name)), name);
      this._segmentRecords.set(name, entries);
    }
    // Crash recovery: a stale tmp manifest and orphan segment files (written
    // but never committed by rename) are discarded; the old manifest wins.
    fs.rmSync(this.manifestTmpPath, { force: true });
    for (const f of fs.readdirSync(this.segDir)) {
      if (!this.manifest.segments.includes(f)) {
        fs.rmSync(path.join(this.segDir, f), { force: true });
      }
    }
    this._rebuildIndex();
    const last = this.manifest.segments[this.manifest.segments.length - 1];
    if (last) {
      const entries = this._segmentRecords.get(last);
      if (entries.length < segmentCapacity(this.segmentSize)) {
        const file = path.join(this.segDir, last);
        const body = Buffer.alloc(this.segmentSize);
        fs.readFileSync(file).copy(body);
        this._active = { name: last, fd: fs.openSync(file, 'r+'), count: entries.length, body };
      }
    }
  }

  _rebuildIndex() {
    this.devices.clear();
    for (const name of this.manifest.segments) {
      for (const e of this._segmentRecords.get(name) ?? []) {
        this._indexRecord(name, e.offset, e.rec);
      }
    }
  }

  _indexRecord(segment, offset, rec) {
    let d = this.devices.get(rec.device);
    if (!d) {
      d = { minSeq: rec.seq, maxSeq: rec.seq, records: [] };
      this.devices.set(rec.device, d);
    }
    if (rec.seq < d.minSeq) d.minSeq = rec.seq;
    if (rec.seq > d.maxSeq) d.maxSeq = rec.seq;
    d.records.push({ seq: rec.seq, segment, offset, rec });
  }

  append(input) {
    const rec = { severity: 0, message: '', ts: Date.now(), ...input };
    rec.seq = BigInt(rec.seq);
    const d = this.devices.get(rec.device);
    if (d) {
      const expected = d.maxSeq + 1n;
      if (rec.seq <= d.maxSeq) {
        this.duplicates++;
        const key = `${rec.device}:${rec.seq}`;
        const dedup = (this.dedupCounts.get(key) ?? 0) + 1;
        this.dedupCounts.set(key, dedup);
        return { status: 'duplicate', dedup };
      }
      if (rec.seq > expected) {
        throw new AlertError(
          'E_GAP',
          `sequence gap for device ${rec.device}: expected ${expected}, got ${rec.seq}`,
          { expected, got: rec.seq },
        );
      }
    }
    this._writeRecord(rec);
    return { status: 'ok', seq: rec.seq };
  }

  _writeRecord(rec) {
    if (!this._active || this._active.count >= segmentCapacity(this.segmentSize)) {
      this._rotate();
    }
    const a = this._active;
    const offset = HEADER_SIZE + a.count * RECORD_SIZE;
    const encoded = encodeRecord(rec);
    encoded.copy(a.body, offset);
    fs.writeSync(a.fd, encoded, 0, RECORD_SIZE, offset);
    a.count++;
    a.body.writeUInt32LE(a.count, 5);
    a.body.writeUInt32LE(crc32(a.body.subarray(HEADER_SIZE, HEADER_SIZE + a.count * RECORD_SIZE)), 9);
    fs.writeSync(a.fd, a.body.subarray(0, HEADER_SIZE), 0, HEADER_SIZE, 0);
    const entry = { offset, rec };
    this._segmentRecords.get(a.name).push(entry);
    this._indexRecord(a.name, offset, rec);
  }

  // Ring overwrite: the new segment is fully written and fsynced BEFORE the
  // manifest is swapped via tmp-file + atomic rename. A crash before the
  // rename leaves the old readable segment list (and old segments) intact;
  // after the rename the new list takes effect and evicted files are removed.
  _rotate() {
    if (this._active) {
      fs.fsyncSync(this._active.fd);
      fs.closeSync(this._active.fd);
      this._active = null;
    }
    const id = this.manifest.nextSegmentId;
    const name = segmentName(id);
    const file = path.join(this.segDir, name);
    const body = buildSegmentBuffer([], this.segmentSize);
    const fd = fs.openSync(file, 'w');
    fs.writeSync(fd, body, 0, body.length, 0);
    fs.fsyncSync(fd);
    this._segmentRecords.set(name, []);

    const segments = [...this.manifest.segments, name];
    const evicted = [];
    while (segments.length > this.maxSegments) evicted.push(segments.shift());
    const next = { version: VERSION, segments, nextSegmentId: id + 1 };
    fs.writeFileSync(this.manifestTmpPath, JSON.stringify(next));
    const tmpFd = fs.openSync(this.manifestTmpPath, 'r');
    fs.fsyncSync(tmpFd);
    fs.closeSync(tmpFd);
    fs.renameSync(this.manifestTmpPath, this.manifestPath);
    fsyncDir(this.dir);
    this.manifest = next;

    for (const e of evicted) {
      fs.rmSync(path.join(this.segDir, e), { force: true });
      this._segmentRecords.delete(e);
    }
    if (evicted.length) this._rebuildIndex();
    fsyncDir(this.segDir);

    this._active = { name, fd, count: 0, body };
  }

  replay(cursorToken) {
    const cursor = cursorToken ? decodeCursor(cursorToken) : { devices: {} };
    const alerts = [];
    for (const [device, d] of this.devices) {
      const after = cursor.devices[device] ? BigInt(cursor.devices[device].seq) : null;
      for (const e of d.records) {
        if (after !== null && e.seq <= after) continue;
        alerts.push(e.rec);
      }
    }
    alerts.sort((x, y) =>
      (x.severity - y.severity) ||
      (x.device < y.device ? -1 : x.device > y.device ? 1 : 0) ||
      (x.seq < y.seq ? -1 : x.seq > y.seq ? 1 : 0));
    const devices = { ...cursor.devices };
    for (const [device, d] of this.devices) {
      devices[device] = { seq: d.maxSeq.toString(), digest: this.prefixDigest(device, d.maxSeq) };
    }
    return { alerts, cursor: encodeCursor({ v: 1, devices }) };
  }

  // Digest of the device's contiguous acknowledged prefix [minSeq, uptoSeq].
  prefixDigest(device, uptoSeq) {
    const d = this.devices.get(device);
    if (!d) return null;
    const upto = BigInt(uptoSeq);
    const recs = d.records
      .filter((e) => e.seq >= d.minSeq && e.seq <= upto)
      .sort((a, b) => (a.seq < b.seq ? -1 : 1));
    if (recs.length !== Number(upto - d.minSeq + 1n)) return null;
    return crc32(Buffer.concat(recs.map((e) => encodeRecord(e.rec)))).toString(16).padStart(8, '0');
  }

  verifyCursor(token) {
    const cursor = decodeCursor(token);
    for (const [device, entry] of Object.entries(cursor.devices)) {
      const digest = this.prefixDigest(device, entry.seq);
      if (digest === null || digest !== entry.digest) return false;
    }
    return true;
  }

  indexSnapshot() {
    const devices = {};
    for (const [device, d] of this.devices) {
      devices[device] = {
        minSeq: d.minSeq.toString(),
        maxSeq: d.maxSeq.toString(),
        offsets: d.records.map((e) => ({ seq: e.seq.toString(), segment: e.segment, offset: e.offset })),
      };
    }
    return { devices };
  }

  stats() {
    return {
      devices: this.devices.size,
      segments: this.manifest.segments.length,
      alerts: [...this.devices.values()].reduce((n, d) => n + d.records.length, 0),
      duplicates: this.duplicates,
    };
  }

  close() {
    if (this._active) {
      fs.fsyncSync(this._active.fd);
      fs.closeSync(this._active.fd);
      this._active = null;
    }
    fs.writeFileSync(this.indexPath, JSON.stringify(this.indexSnapshot(), null, 2));
  }
}
