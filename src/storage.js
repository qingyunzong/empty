'use strict';

const fs = require('fs');
const path = require('path');
const { crc32 } = require('./crc32');
const { RecoveryError } = require('./errors');

const FLUSH_THRESHOLD = 128;

function manifestPath(dir) { return path.join(dir, 'manifest.json'); }
function walPath(dir) { return path.join(dir, 'wal.log'); }
function segmentFileName(id) { return `segment-${String(id).padStart(6, '0')}.jsonl`; }
function indexFileName(id) { return `segment-${String(id).padStart(6, '0')}.idx.json`; }

function cmpRecord(a, b) {
  if (a.ts !== b.ts) return a.ts - b.ts;
  if (a.device !== b.device) return a.device < b.device ? -1 : 1;
  return a.seq - b.seq;
}

function initialManifest() {
  return { version: 1, lastSeq: 0, segments: [] };
}

function readManifest(dir) {
  const p = manifestPath(dir);
  if (!fs.existsSync(p)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    throw new RecoveryError('manifest.json is corrupt');
  }
  if (!parsed || !Array.isArray(parsed.segments) || typeof parsed.lastSeq !== 'number') {
    throw new RecoveryError('manifest.json has an invalid structure');
  }
  return parsed;
}

function writeManifestAtomic(dir, manifest) {
  const tmp = manifestPath(dir) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
  fs.renameSync(tmp, manifestPath(dir));
}

function encodeWalBatch(records) {
  const payload = JSON.stringify({ records });
  const crc = crc32(Buffer.from(payload, 'utf8'));
  return JSON.stringify({ crc, payload }) + '\n';
}

function scanWal(dir) {
  const p = walPath(dir);
  if (!fs.existsSync(p)) {
    return { records: [], validBytes: 0, totalBytes: 0, truncated: false };
  }
  const buf = fs.readFileSync(p);
  const records = [];
  let off = 0;
  while (off < buf.length) {
    const nl = buf.indexOf(0x0a, off);
    if (nl === -1) break;
    const line = buf.slice(off, nl);
    let ok = false;
    try {
      const obj = JSON.parse(line.toString('utf8'));
      if (
        obj && typeof obj.crc === 'number' && typeof obj.payload === 'string'
        && crc32(Buffer.from(obj.payload, 'utf8')) === obj.crc
      ) {
        const payload = JSON.parse(obj.payload);
        if (payload && Array.isArray(payload.records)) {
          records.push(...payload.records);
          ok = true;
        }
      }
    } catch {
      ok = false;
    }
    if (!ok) break;
    off = nl + 1;
  }
  return { records, validBytes: off, totalBytes: buf.length, truncated: off < buf.length };
}

function truncateWal(dir, bytes) {
  const p = walPath(dir);
  if (!fs.existsSync(p)) return;
  fs.truncateSync(p, bytes);
}

function readSegmentRecords(dir, segMeta) {
  const p = path.join(dir, segMeta.file);
  const out = [];
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    out.push(JSON.parse(line));
  }
  return out;
}

function buildIndex(segMeta, records) {
  const sorted = [...records].sort(cmpRecord);
  return {
    segmentId: segMeta.id,
    count: sorted.length,
    minTs: sorted.length ? sorted[0].ts : null,
    maxTs: sorted.length ? sorted[sorted.length - 1].ts : null,
    entries: sorted.map((r) => [r.ts, r.device, r.seq]),
  };
}

function writeIndex(dir, segMeta, records) {
  const idx = buildIndex(segMeta, records);
  fs.writeFileSync(path.join(dir, indexFileName(segMeta.id)), JSON.stringify(idx));
  return idx;
}

function readIndex(dir, segId) {
  const p = path.join(dir, indexFileName(segId));
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function indexValid(idx, segMeta) {
  return Boolean(
    idx
    && idx.segmentId === segMeta.id
    && idx.count === segMeta.count
    && idx.minTs === segMeta.minTs
    && idx.maxTs === segMeta.maxTs,
  );
}

function appendBatch(dir, records) {
  fs.mkdirSync(dir, { recursive: true });
  const manifest = readManifest(dir) || initialManifest();
  let wal = scanWal(dir);
  if (wal.truncated) truncateWal(dir, wal.validBytes);
  let nextSeq = manifest.lastSeq;
  for (const r of wal.records) nextSeq = Math.max(nextSeq, r.seq);
  const stamped = records.map((r, i) => ({ ...r, seq: nextSeq + 1 + i }));
  if (stamped.length === 0) return 0;
  fs.appendFileSync(walPath(dir), encodeWalBatch(stamped));
  const fd = fs.openSync(walPath(dir), 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  wal = scanWal(dir);
  if (wal.records.length >= FLUSH_THRESHOLD) flush(dir);
  return stamped.length;
}

function flush(dir) {
  const manifest = readManifest(dir) || initialManifest();
  const wal = scanWal(dir);
  if (wal.records.length === 0) return null;
  const id = manifest.segments.length
    ? Math.max(...manifest.segments.map((s) => s.id)) + 1
    : 1;
  const file = segmentFileName(id);
  const sorted = [...wal.records].sort(cmpRecord);
  fs.writeFileSync(path.join(dir, file), sorted.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const tsVals = sorted.map((r) => r.ts);
  const segMeta = {
    id,
    file,
    count: sorted.length,
    minTs: Math.min(...tsVals),
    maxTs: Math.max(...tsVals),
  };
  manifest.segments.push(segMeta);
  manifest.lastSeq = Math.max(manifest.lastSeq, ...sorted.map((r) => r.seq));
  writeManifestAtomic(dir, manifest);
  writeIndex(dir, segMeta, sorted);
  fs.writeFileSync(walPath(dir), '');
  return id;
}

function openDb(dir) {
  const manifest = readManifest(dir) || initialManifest();
  const segments = manifest.segments.map((segMeta) => ({
    meta: segMeta,
    records: readSegmentRecords(dir, segMeta),
    index: readIndex(dir, segMeta.id),
  }));
  const wal = scanWal(dir);
  const inSegments = new Set();
  for (const seg of segments) for (const r of seg.records) inSegments.add(r.seq);
  const walRecords = wal.records.filter((r) => !inSegments.has(r.seq) && r.seq > manifest.lastSeq);
  return { manifest, segments, walRecords };
}

function recover(dir) {
  if (!fs.existsSync(dir)) {
    throw new RecoveryError(`database directory '${dir}' does not exist`);
  }
  const stats = { truncatedBytes: 0, removedOrphans: [], rebuiltIndexes: [], droppedWalRecords: 0 };
  let manifest = readManifest(dir);
  if (!manifest) {
    manifest = initialManifest();
    writeManifestAtomic(dir, manifest);
  }
  const wal = scanWal(dir);
  if (wal.truncated) {
    truncateWal(dir, wal.validBytes);
    stats.truncatedBytes = wal.totalBytes - wal.validBytes;
  }
  const knownIds = new Set(manifest.segments.map((s) => s.id));
  for (const f of fs.readdirSync(dir)) {
    const m = /^segment-(\d+)\.(?:jsonl|idx\.json)$/.exec(f);
    if (m && !knownIds.has(parseInt(m[1], 10))) {
      fs.unlinkSync(path.join(dir, f));
      stats.removedOrphans.push(f);
    }
  }
  const keptWal = wal.records.filter((r) => r.seq > manifest.lastSeq);
  if (keptWal.length !== wal.records.length) {
    stats.droppedWalRecords = wal.records.length - keptWal.length;
    fs.writeFileSync(walPath(dir), keptWal.length ? encodeWalBatch(keptWal) : '');
  }
  for (const segMeta of manifest.segments) {
    const segPath = path.join(dir, segMeta.file);
    if (!fs.existsSync(segPath)) {
      throw new RecoveryError(`segment file '${segMeta.file}' referenced by manifest is missing`);
    }
    const idx = readIndex(dir, segMeta.id);
    if (!indexValid(idx, segMeta)) {
      writeIndex(dir, segMeta, readSegmentRecords(dir, segMeta));
      stats.rebuiltIndexes.push(segMeta.id);
    }
  }
  return stats;
}

module.exports = {
  FLUSH_THRESHOLD,
  cmpRecord,
  appendBatch,
  flush,
  openDb,
  recover,
  scanWal,
  readManifest,
  readSegmentRecords,
  segmentFileName,
  indexFileName,
  walPath,
  manifestPath,
};
