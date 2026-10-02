import fs from 'node:fs';
import path from 'node:path';
import { crc32 } from './crc32.js';

export class RecoveryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RecoveryError';
  }
}

const WAL_FILE = 'wal.log';
const MANIFEST_FILE = 'manifest.json';
const SEGMENTS_DIR = 'segments';

export function dbPaths(dir) {
  return {
    wal: path.join(dir, WAL_FILE),
    manifest: path.join(dir, MANIFEST_FILE),
    segmentsDir: path.join(dir, SEGMENTS_DIR),
  };
}

function segmentFileName(segId) {
  return `seg-${String(segId).padStart(6, '0')}.jsonl`;
}

function indexFileName(segId) {
  return `seg-${String(segId).padStart(6, '0')}.idx.json`;
}

function writeFileSyncFsync(file, data) {
  const fd = fs.openSync(file, 'w');
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// ---------- manifest ----------

function manifestChecksum(m) {
  const body = JSON.stringify({
    version: m.version,
    nextSeq: m.nextSeq,
    nextSeg: m.nextSeg,
    segments: m.segments,
  });
  return crc32(Buffer.from(body, 'utf8'));
}

function writeManifest(dir, m) {
  const { manifest } = dbPaths(dir);
  const full = { ...m, checksum: manifestChecksum(m) };
  const tmp = manifest + '.tmp';
  writeFileSyncFsync(tmp, JSON.stringify(full, null, 2));
  fs.renameSync(tmp, manifest);
}

export function readManifest(dir) {
  const { manifest } = dbPaths(dir);
  let raw;
  try {
    raw = fs.readFileSync(manifest, 'utf8');
  } catch {
    throw new RecoveryError(`manifest not found in ${dir}`);
  }
  let m;
  try {
    m = JSON.parse(raw);
  } catch {
    throw new RecoveryError('manifest is not valid JSON');
  }
  if (typeof m !== 'object' || m === null || m.version !== 1 ||
      typeof m.nextSeq !== 'number' || typeof m.nextSeg !== 'number' ||
      !Array.isArray(m.segments) || typeof m.checksum !== 'number') {
    throw new RecoveryError('manifest has invalid structure');
  }
  if (manifestChecksum(m) !== m.checksum) {
    throw new RecoveryError('manifest checksum mismatch');
  }
  return m;
}

// ---------- WAL ----------

function encodeWalFrame(record) {
  const payload = Buffer.from(JSON.stringify(record), 'utf8');
  const frame = Buffer.alloc(8 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  frame.writeUInt32LE(crc32(payload), 4 + payload.length);
  return frame;
}

function appendWal(dir, records) {
  const { wal } = dbPaths(dir);
  const fd = fs.openSync(wal, 'a');
  try {
    for (const rec of records) {
      fs.writeFileSync(fd, encodeWalFrame(rec));
    }
    fs.fsyncSync(fd); // commit point: records are durable once fsynced
  } finally {
    fs.closeSync(fd);
  }
}

export function readWal(dir) {
  const { wal } = dbPaths(dir);
  let buf;
  try {
    buf = fs.readFileSync(wal);
  } catch {
    return { records: [], validBytes: 0, corrupted: false, totalBytes: 0 };
  }
  const records = [];
  let off = 0;
  let corrupted = false;
  while (off < buf.length) {
    if (buf.length - off < 8) { corrupted = true; break; }
    const len = buf.readUInt32LE(off);
    if (len <= 0 || len > 16 * 1024 * 1024 || buf.length - off < 8 + len) {
      corrupted = true;
      break;
    }
    const payload = buf.subarray(off + 4, off + 4 + len);
    const crc = buf.readUInt32LE(off + 4 + len);
    if (crc32(payload) !== crc) { corrupted = true; break; }
    let rec;
    try {
      rec = JSON.parse(payload.toString('utf8'));
    } catch {
      corrupted = true;
      break;
    }
    records.push(rec);
    off += 8 + len;
  }
  return { records, validBytes: off, corrupted, totalBytes: buf.length };
}

function truncateWal(dir, bytes) {
  const { wal } = dbPaths(dir);
  const fd = fs.openSync(wal, 'r+');
  try {
    fs.ftruncateSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// ---------- segments & indexes ----------

function writeSegment(dir, segId, records) {
  const { segmentsDir } = dbPaths(dir);
  const file = path.join(segmentsDir, segmentFileName(segId));
  const body = records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');
  writeFileSyncFsync(file, body);
  return segmentFileName(segId);
}

export function readSegment(dir, file) {
  const { segmentsDir } = dbPaths(dir);
  let raw;
  try {
    raw = fs.readFileSync(path.join(segmentsDir, file), 'utf8');
  } catch {
    throw new RecoveryError(`segment ${file} referenced by manifest is missing`);
  }
  const records = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === '') continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      throw new RecoveryError(`segment ${file} is corrupted at line ${i + 1}`);
    }
  }
  return records;
}

function buildIndex(dir, segId, records) {
  const { segmentsDir } = dbPaths(dir);
  const entries = records.map((r, row) => [r.ts, row]);
  entries.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  const idx = { segId, count: records.length, entries };
  writeFileSyncFsync(path.join(segmentsDir, indexFileName(segId)), JSON.stringify(idx));
}

export function readIndex(dir, segId) {
  const { segmentsDir } = dbPaths(dir);
  try {
    const idx = JSON.parse(fs.readFileSync(path.join(segmentsDir, indexFileName(segId)), 'utf8'));
    if (!Array.isArray(idx.entries)) return null;
    return idx;
  } catch {
    return null;
  }
}

// ---------- record validation ----------

export function normalizeRecord(input, lineNo) {
  const where = lineNo === undefined ? '' : ` (line ${lineNo})`;
  if (typeof input !== 'object' || input === null) {
    throw new Error(`invalid record${where}: not an object`);
  }
  const { ts, device, code, value } = input;
  let tsMs;
  if (typeof ts === 'number' && Number.isFinite(ts)) {
    tsMs = ts;
  } else if (typeof ts === 'string') {
    tsMs = Date.parse(ts);
    if (Number.isNaN(tsMs)) throw new Error(`invalid record${where}: bad ts "${ts}"`);
  } else {
    throw new Error(`invalid record${where}: ts must be epoch ms or ISO string`);
  }
  if (typeof device !== 'string' || device === '') {
    throw new Error(`invalid record${where}: device must be a non-empty string`);
  }
  if (typeof code !== 'string') {
    throw new Error(`invalid record${where}: code must be a string`);
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`invalid record${where}: value must be a finite number`);
  }
  return { ts: tsMs, device, code, value };
}

// ---------- database open / append ----------

export function ensureDb(dir) {
  const { segmentsDir, wal, manifest } = dbPaths(dir);
  fs.mkdirSync(segmentsDir, { recursive: true });
  if (!fs.existsSync(manifest)) {
    writeManifest(dir, { version: 1, nextSeq: 0, nextSeg: 1, segments: [] });
  }
  if (!fs.existsSync(wal)) {
    writeFileSyncFsync(wal, Buffer.alloc(0));
  }
}

// Append a batch of records. Order of durable steps:
//   1. WAL append + fsync            (commit point)
//   2. segment flush + fsync
//   3. manifest update (atomic rename)
//   4. index build
//   5. WAL truncate
// hooks.stopAfter ('wal' | 'segment' | 'manifest') simulates a crash for tests.
export function appendBatch(dir, inputRecords, hooks = {}) {
  ensureDb(dir);
  const m = readManifest(dir);
  const records = inputRecords.map((r, i) => ({ ...r, seq: m.nextSeq + i }));
  if (records.length === 0) return { appended: 0 };

  appendWal(dir, records);
  if (hooks.stopAfter === 'wal') return { appended: 0, crashed: 'wal' };

  const segId = m.nextSeg;
  const file = writeSegment(dir, segId, records);
  if (hooks.stopAfter === 'segment') return { appended: 0, crashed: 'segment' };

  m.segments.push({
    file,
    segId,
    count: records.length,
    minSeq: records[0].seq,
    maxSeq: records[records.length - 1].seq,
  });
  m.nextSeq += records.length;
  m.nextSeg += 1;
  writeManifest(dir, m);
  if (hooks.stopAfter === 'manifest') return { appended: 0, crashed: 'manifest' };

  buildIndex(dir, segId, records);
  truncateWal(dir, 0);
  return { appended: records.length };
}

// ---------- recovery ----------

export function recover(dir) {
  const summary = {
    truncatedWalBytes: 0,
    replayedRecords: 0,
    orphansRemoved: [],
    indexesRebuilt: [],
  };
  if (!fs.existsSync(dir)) {
    throw new RecoveryError(`database directory ${dir} does not exist`);
  }
  const m = readManifest(dir); // throws RecoveryError on corrupt manifest
  const { segmentsDir } = dbPaths(dir);
  fs.mkdirSync(segmentsDir, { recursive: true });

  // 1. validate WAL, truncate checksum-failing tail
  const walState = readWal(dir);
  if (walState.corrupted) {
    truncateWal(dir, walState.validBytes);
    summary.truncatedWalBytes = walState.totalBytes - walState.validBytes;
  }

  // 2. remove orphan segments (flushed but never committed to the manifest).
  //    Must happen before replay, which may reuse the same segment id.
  const known = new Set(m.segments.map((s) => s.file));
  const knownIdx = new Set(m.segments.map((s) => indexFileName(s.segId)));
  for (const f of fs.readdirSync(segmentsDir)) {
    if (f.endsWith('.jsonl') && !known.has(f)) {
      fs.rmSync(path.join(segmentsDir, f), { force: true });
      summary.orphansRemoved.push(f);
    } else if (f.endsWith('.idx.json') && !knownIdx.has(f)) {
      fs.rmSync(path.join(segmentsDir, f), { force: true });
      summary.orphansRemoved.push(f);
    }
  }

  // 3. replay committed-but-unflushed WAL records into a new segment.
  //    Records with seq < manifest.nextSeq are already in a segment
  //    (crash between manifest update and WAL truncate) and are dropped.
  const pending = walState.records.filter((r) => typeof r.seq === 'number' && r.seq >= m.nextSeq);
  if (pending.length > 0) {
    pending.sort((a, b) => a.seq - b.seq);
    const segId = m.nextSeg;
    const file = writeSegment(dir, segId, pending);
    m.segments.push({
      file,
      segId,
      count: pending.length,
      minSeq: pending[0].seq,
      maxSeq: pending[pending.length - 1].seq,
    });
    m.nextSeq = pending[pending.length - 1].seq + 1;
    m.nextSeg += 1;
    writeManifest(dir, m);
    buildIndex(dir, segId, pending);
    summary.replayedRecords = pending.length;
  }
  if (walState.records.length > 0 || walState.corrupted) {
    truncateWal(dir, 0);
  }

  // 4. rebuild missing indexes (crash between manifest update and index build)
  for (const seg of m.segments) {
    if (readIndex(dir, seg.segId) === null) {
      buildIndex(dir, seg.segId, readSegment(dir, seg.file));
      summary.indexesRebuilt.push(seg.file);
    }
  }

  return summary;
}

// ---------- committed view ----------

// Returns every record a query is allowed to see: manifest segments plus the
// valid committed WAL prefix that has not been flushed yet.
export function readCommitted(dir) {
  const m = readManifest(dir);
  const segments = m.segments.map((seg) => ({
    seg,
    records: readSegment(dir, seg.file),
  }));
  const walState = readWal(dir);
  const pending = walState.records.filter((r) => typeof r.seq === 'number' && r.seq >= m.nextSeq);
  return { manifest: m, segments, pending };
}

export function allCommittedRecords(dir) {
  const { segments, pending } = readCommitted(dir);
  const out = [];
  for (const s of segments) out.push(...s.records);
  out.push(...pending);
  return out;
}
