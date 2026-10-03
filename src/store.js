import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const ZERO_HASH = '0'.repeat(64);

export class EvidenceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'EvidenceError';
    this.code = code;
    Object.assign(this, details);
  }
}

function sha256hex(parts) {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest('hex');
}

// Deterministic serialization (sorted keys) so hashes are reproducible anywhere.
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

// The canonical content bytes of a record (everything except hash/prevHash).
export function recordContent(rec) {
  return canonical({
    seq: rec.seq,
    batch: rec.batch,
    id: rec.id,
    submitter: rec.submitter,
    timestamp: rec.timestamp,
    data: rec.data,
  });
}

// Hash chain: H(prevHash || content).
export function recordHash(prevHashHex, rec) {
  return sha256hex([Buffer.from(prevHashHex, 'hex'), Buffer.from(recordContent(rec), 'utf8')]);
}

function fsyncDir(dir) {
  try {
    const fd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch { /* best effort on platforms that disallow dir fsync */ }
}

function writeFileAtomic(file, data) {
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  fsyncDir(path.dirname(file));
}

function appendWithFsync(file, buf) {
  const fd = fs.openSync(file, 'a');
  try {
    fs.writeFileSync(fd, buf);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

function truncateWithFsync(file, size) {
  const fd = fs.openSync(file, 'r+');
  try {
    fs.ftruncateSync(fd, size);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

function encodeFrame(obj) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(payload.length, 0);
  return Buffer.concat([len, payload]);
}

// Iterate frames of data.log. Calls fn(record, frameOffset) for each.
function scanDataLog(file, fn) {
  if (!fs.existsSync(file)) return;
  const buf = fs.readFileSync(file);
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) {
      throw new EvidenceError('TAMPER', `truncated frame header at offset ${off}`, { offset: off });
    }
    const len = buf.readUInt32BE(off);
    if (off + 4 + len > buf.length) {
      throw new EvidenceError('TAMPER', `truncated record at offset ${off}`, { offset: off });
    }
    let rec;
    try {
      rec = JSON.parse(buf.subarray(off + 4, off + 4 + len).toString('utf8'));
    } catch {
      throw new EvidenceError('TAMPER', `unparseable record at offset ${off}`, { offset: off });
    }
    fn(rec, off);
    off += 4 + len;
  }
}

function emptyIndex() {
  return { byId: {}, bySubmitter: {}, byTime: [] };
}

function indexAdd(idx, rec, offset) {
  idx.byId[rec.id] = offset;
  (idx.bySubmitter[rec.submitter] ??= []).push(rec.id);
  idx.byTime.push({ t: rec.timestamp, id: rec.id });
  idx.byTime.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
}

export class EvidenceStore {
  constructor(dir, opts = {}) {
    this.dir = dir;
    this.crashBeforeCert =
      opts.crashBeforeCert ?? process.env.EVIDENCE_CRASH_BEFORE_CERT === '1';
    fs.mkdirSync(path.join(dir, 'certs'), { recursive: true });
    this.dataFile = path.join(dir, 'data.log');
    this.walFile = path.join(dir, 'wal.log');
    this.indexFile = path.join(dir, 'index.json');
    this.certsDir = path.join(dir, 'certs');
    this._recover();
  }

  certFile(batch) {
    return path.join(this.certsDir, String(batch).padStart(6, '0') + '.cert');
  }

  _hasCert(batch) {
    return fs.existsSync(this.certFile(batch));
  }

  _recover() {
    // 1. Resolve any interrupted transaction from the WAL.
    if (fs.existsSync(this.walFile) && fs.statSync(this.walFile).size > 0) {
      const lines = fs.readFileSync(this.walFile, 'utf8').split('\n').filter(Boolean);
      let begin = null;
      for (const line of lines) {
        try {
          const e = JSON.parse(line);
          if (e.type === 'begin') begin = e;
        } catch { /* torn tail write: ignore */ }
      }
      if (begin && !this._hasCert(begin.batch)) {
        // Crash before cert write: roll back the whole batch.
        truncateWithFsync(this.dataFile, begin.baseOffset);
      }
      // Either rolled back or fully committed (cert exists): clear the WAL.
      truncateWithFsync(this.walFile, 0);
    }

    // 2. Load committed records and rebuild in-memory state.
    this.records = [];
    this.offsets = [];
    this.lastHash = ZERO_HASH;
    this.lastSeq = -1;
    this.nextBatch = 1;
    this.index = emptyIndex();
    scanDataLog(this.dataFile, (rec, off) => {
      this.records.push(rec);
      this.offsets.push(off);
      this.lastHash = rec.hash;
      this.lastSeq = rec.seq;
      this.nextBatch = Math.max(this.nextBatch, rec.batch + 1);
      indexAdd(this.index, rec, off);
    });
  }

  // Commit a batch of entries: [{id, submitter, data, timestamp?}, ...]
  commit(entries) {
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new EvidenceError('EMPTY_BATCH', 'batch must contain at least one record');
    }
    for (const e of entries) {
      if (!e.id || !e.submitter) {
        throw new EvidenceError('INVALID', 'each record needs id and submitter');
      }
      if (this.index.byId[e.id] !== undefined) {
        throw new EvidenceError('DUP_ID', `duplicate evidence id: ${e.id}`, { id: e.id });
      }
    }

    const batch = this.nextBatch;
    const baseOffset = fs.existsSync(this.dataFile) ? fs.statSync(this.dataFile).size : 0;

    // Build chained records.
    const records = [];
    let prevHash = this.lastHash;
    let seq = this.lastSeq;
    for (const e of entries) {
      const rec = {
        seq: ++seq,
        batch,
        id: e.id,
        submitter: e.submitter,
        timestamp: e.timestamp ?? new Date().toISOString(),
        data: e.data,
        prevHash,
      };
      rec.hash = recordHash(prevHash, rec);
      prevHash = rec.hash;
      records.push(rec);
    }
    const headHash = records[records.length - 1].hash;

    // 1. WAL first (begin + all records), fsync.
    const walLines = [
      JSON.stringify({ type: 'begin', batch, baseOffset, prevHash: this.lastHash }),
      ...records.map((r) => JSON.stringify({ type: 'record', payload: r })),
      JSON.stringify({ type: 'end', batch }),
    ];
    appendWithFsync(this.walFile, Buffer.from(walLines.join('\n') + '\n', 'utf8'));

    // 2. Apply records to data.log, fsync.
    appendWithFsync(this.dataFile, Buffer.concat(records.map(encodeFrame)));

    // Crash-injection point for acceptance scenario (3).
    if (this.crashBeforeCert) process.exit(2);

    // 3. Persist commit certificate (atomic rename).
    const cert = {
      version: 1,
      batch,
      headHash,
      prevHeadHash: this.lastHash,
      recordCount: records.length,
      recordIds: records.map((r) => r.id),
      dataBaseOffset: baseOffset,
      committedAt: new Date().toISOString(),
    };
    writeFileAtomic(this.certFile(batch), JSON.stringify(cert, null, 2) + '\n');

    // 4. Update secondary index (derived data; rebuilt & checked on recovery).
    for (let i = 0; i < records.length; i++) {
      indexAdd(this.index, records[i], baseOffset + frameOffsetOf(records, i));
    }
    writeFileAtomic(this.indexFile, JSON.stringify(this.index, null, 2) + '\n');

    // 5. Commit complete: clear WAL.
    truncateWithFsync(this.walFile, 0);

    this.records.push(...records);
    let off = baseOffset;
    for (const r of records) { this.offsets.push(off); off += 4 + Buffer.byteLength(JSON.stringify(r)); }
    this.lastHash = headHash;
    this.lastSeq = seq;
    this.nextBatch = batch + 1;
    return cert;
  }

  get(id) {
    const off = this.index.byId[id];
    if (off === undefined) {
      throw new EvidenceError('NOT_FOUND', `no evidence with id: ${id}`, { id });
    }
    const idx = this.offsets.indexOf(off);
    const rec = this.records[idx];
    // Immediate re-verification on read.
    if (recordHash(rec.prevHash, rec) !== rec.hash) {
      throw new EvidenceError('TAMPER', `hash mismatch for record ${id} at offset ${off}`, { offset: off, id });
    }
    return rec;
  }

  list({ submitter, from, to } = {}) {
    let ids = null;
    if (submitter !== undefined) ids = new Set(this.index.bySubmitter[submitter] ?? []);
    if (from !== undefined || to !== undefined) {
      const ranged = new Set(
        this.index.byTime
          .filter((e) => (from === undefined || e.t >= from) && (to === undefined || e.t <= to))
          .map((e) => e.id),
      );
      ids = ids === null ? ranged : new Set([...ids].filter((x) => ranged.has(x)));
    }
    return this.records.filter((r) => ids === null || ids.has(r.id));
  }

  cert(batch) {
    const file = this.certFile(batch);
    if (!fs.existsSync(file)) {
      throw new EvidenceError('NO_CERT', `no certificate for batch ${batch}`, { batch });
    }
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  // Rebuild the index from data.log alone (ground truth).
  _rebuildIndex() {
    const idx = emptyIndex();
    scanDataLog(this.dataFile, (rec, off) => indexAdd(idx, rec, off));
    return idx;
  }

  // Replay the whole log: check hash chain, certificates, and index consistency.
  verify() {
    let prevHash = ZERO_HASH;
    let recordCount = 0;
    const batches = new Map(); // batch -> {headHash, count}
    scanDataLog(this.dataFile, (rec, off) => {
      if (rec.prevHash !== prevHash) {
        throw new EvidenceError('TAMPER', `chain link broken at offset ${off} (record id ${rec.id})`, { offset: off, id: rec.id });
      }
      if (recordHash(prevHash, rec) !== rec.hash) {
        throw new EvidenceError('TAMPER', `hash mismatch at offset ${off} (record id ${rec.id})`, { offset: off, id: rec.id });
      }
      prevHash = rec.hash;
      recordCount++;
      const b = batches.get(rec.batch) ?? { headHash: null, count: 0 };
      b.headHash = rec.hash;
      b.count++;
      batches.set(rec.batch, b);
    });

    // Every batch must have a matching certificate.
    for (const [batch, info] of batches) {
      if (!this._hasCert(batch)) {
        throw new EvidenceError('NO_CERT', `missing certificate for batch ${batch}`, { batch });
      }
      const cert = this.cert(batch);
      if (cert.headHash !== info.headHash || cert.recordCount !== info.count) {
        throw new EvidenceError('TAMPER', `certificate mismatch for batch ${batch}`, { batch });
      }
    }
    // No orphan certificates without records.
    const certFiles = fs.readdirSync(this.certsDir).filter((f) => f.endsWith('.cert'));
    if (certFiles.length !== batches.size) {
      throw new EvidenceError('TAMPER', `certificate count ${certFiles.length} != batch count ${batches.size}`);
    }

    // Secondary index must match ground truth rebuilt from data.log.
    const rebuilt = JSON.stringify(this._rebuildIndex());
    const persisted = fs.existsSync(this.indexFile)
      ? JSON.stringify(JSON.parse(fs.readFileSync(this.indexFile, 'utf8')))
      : null;
    if (persisted === null || persisted !== rebuilt) {
      throw new EvidenceError('TAMPER', 'secondary index inconsistent with data.log');
    }

    return { ok: true, records: recordCount, batches: batches.size, headHash: prevHash };
  }
}

function frameOffsetOf(records, i) {
  let off = 0;
  for (let k = 0; k < i; k++) off += 4 + Buffer.byteLength(JSON.stringify(records[k]));
  return off;
}
