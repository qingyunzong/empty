'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_FILE = 'data.log';
const WAL_FILE = 'wal.log';
const INDEX_FILE = 'index.json';
const CERT_DIR = 'certs';
const GENESIS_HASH = Buffer.alloc(32).toString('hex');

class StoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
    Object.assign(this, details);
  }
}

function sha256(...parts) {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
}

// Canonical byte representation of a record's content (hash inputs only).
function canonicalContent(rec) {
  return Buffer.from(
    JSON.stringify({
      id: rec.id,
      submitter: rec.submitter,
      timestamp: rec.timestamp,
      payload: rec.payload,
    }),
    'utf8'
  );
}

// recordHash = H(prevHashBytes || contentBytes)
function computeRecordHash(prevHashHex, rec) {
  return sha256(Buffer.from(prevHashHex, 'hex'), canonicalContent(rec)).toString('hex');
}

function encodeFrame(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

function fsyncFile(fd) {
  fs.fsyncSync(fd);
}

function fsyncDir(dir) {
  const fd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

class EvidenceStore {
  constructor(dir, options = {}) {
    this.dir = dir;
    this.dataPath = path.join(dir, DATA_FILE);
    this.walPath = path.join(dir, WAL_FILE);
    this.indexPath = path.join(dir, INDEX_FILE);
    this.certDir = path.join(dir, CERT_DIR);
    // Test hook invoked after data.log is durable but before the
    // certificate is written. Default honors EVSTORE_CRASH_BEFORE_CERT.
    this._beforeCertWrite =
      options.beforeCertWrite ||
      (() => {
        if (process.env.EVSTORE_CRASH_BEFORE_CERT === '1') process.exit(42);
      });
    fs.mkdirSync(this.certDir, { recursive: true });
    this._recover();
  }

  // ---- recovery -----------------------------------------------------------

  _recover() {
    // 1. Determine the committed end offset from the certificates.
    const certs = this._loadCerts();
    let committedEnd = 0;
    for (const cert of certs) {
      if (cert.endOffset > committedEnd) committedEnd = cert.endOffset;
    }

    // 2. If data.log extends past the last certified offset, a crash happened
    //    after appending to data.log but before writing the certificate.
    //    Truncate the uncommitted tail so the batch is entirely invisible.
    if (fs.existsSync(this.dataPath)) {
      const size = fs.statSync(this.dataPath).size;
      if (size > committedEnd) {
        fs.truncateSync(this.dataPath, committedEnd);
      }
    } else if (committedEnd > 0) {
      throw new StoreError('NO_DATA', 'certificates exist but data.log is missing');
    }

    // 3. A leftover WAL means the batch never committed: discard it.
    if (fs.existsSync(this.walPath)) {
      fs.unlinkSync(this.walPath);
    }

    // 4. Rebuild the index from committed data and check it against the
    //    persisted index; rewrite if inconsistent (crash mid-index-update).
    const { index } = this._scan();
    this.index = index;
    const rebuilt = JSON.stringify(index);
    let persisted = null;
    if (fs.existsSync(this.indexPath)) {
      persisted = fs.readFileSync(this.indexPath, 'utf8');
    }
    if (persisted !== rebuilt) {
      this._writeIndex();
    }
  }

  _loadCerts() {
    if (!fs.existsSync(this.certDir)) return [];
    const certs = [];
    for (const name of fs.readdirSync(this.certDir)) {
      if (!name.endsWith('.json')) continue;
      certs.push(JSON.parse(fs.readFileSync(path.join(this.certDir, name), 'utf8')));
    }
    certs.sort((a, b) => a.startOffset - b.startOffset);
    return certs;
  }

  // Scan data.log, returning records (with offsets) and a rebuilt index.
  _scan() {
    const records = [];
    const index = { bySubmitter: {}, byTime: [] };
    if (!fs.existsSync(this.dataPath)) return { records, index };
    const buf = fs.readFileSync(this.dataPath);
    let offset = 0;
    while (offset < buf.length) {
      if (offset + 4 > buf.length) {
        throw new StoreError('CORRUPT', `truncated frame header at offset ${offset}`, { offset });
      }
      const len = buf.readUInt32BE(offset);
      if (offset + 4 + len > buf.length) {
        throw new StoreError('CORRUPT', `truncated frame body at offset ${offset}`, { offset });
      }
      const rec = JSON.parse(buf.subarray(offset + 4, offset + 4 + len).toString('utf8'));
      records.push({ offset, record: rec });
      (index.bySubmitter[rec.submitter] ||= []).push(rec.id);
      index.byTime.push({ timestamp: rec.timestamp, id: rec.id });
      offset += 4 + len;
    }
    index.byTime.sort((a, b) => a.timestamp - b.timestamp);
    return { records, index };
  }

  _writeIndex() {
    const tmp = this.indexPath + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, JSON.stringify(this.index));
      fsyncFile(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.indexPath);
    fsyncDir(this.dir);
  }

  _chainHead() {
    if (!fs.existsSync(this.dataPath)) return GENESIS_HASH;
    const buf = fs.readFileSync(this.dataPath);
    if (buf.length === 0) return GENESIS_HASH;
    let offset = 0;
    let last = null;
    while (offset < buf.length) {
      const len = buf.readUInt32BE(offset);
      last = JSON.parse(buf.subarray(offset + 4, offset + 4 + len).toString('utf8'));
      offset += 4 + len;
    }
    return last.hash;
  }

  // ---- commit -------------------------------------------------------------

  // Commit a batch of records as one transaction.
  // records: [{ id, submitter, timestamp, payload }]
  // Returns the commit certificate.
  commit(records) {
    if (!Array.isArray(records) || records.length === 0) {
      throw new StoreError('EMPTY_BATCH', 'commit requires at least one record');
    }
    const batchId = crypto.randomUUID();

    // Phase 1: write-ahead log.
    const fd = fs.openSync(this.walPath, 'w');
    try {
      fs.writeSync(fd, encodeFrame({ batchId, records }));
      fsyncFile(fd);
    } finally {
      fs.closeSync(fd);
    }
    fsyncDir(this.dir);

    // Phase 2: hash chain over the batch, append frames to data.log.
    const startOffset = fs.existsSync(this.dataPath) ? fs.statSync(this.dataPath).size : 0;
    let prevHash = this._chainHead();
    const prevChainHead = prevHash;
    const frames = [];
    const stored = [];
    records.forEach((rec, seq) => {
      const hash = computeRecordHash(prevHash, rec);
      const full = { ...rec, batchId, seq, prevHash, hash };
      frames.push(encodeFrame(full));
      stored.push(full);
      prevHash = hash;
    });
    const chainHead = prevHash;
    const dataFd = fs.openSync(this.dataPath, 'a');
    try {
      for (const frame of frames) fs.writeSync(dataFd, frame);
      fsyncFile(dataFd);
    } finally {
      fs.closeSync(dataFd);
    }

    // Crash-injection hook: die after data.log is durable but before the
    // certificate is written.
    this._beforeCertWrite();

    // Phase 3: persist the commit certificate (chain head of this batch).
    const endOffset = startOffset + frames.reduce((n, f) => n + f.length, 0);
    const cert = {
      version: 1,
      batchId,
      prevChainHead,
      chainHead,
      recordCount: records.length,
      recordIds: records.map((r) => r.id),
      startOffset,
      endOffset,
      createdAt: new Date().toISOString(),
    };
    const certTmp = path.join(this.certDir, batchId + '.tmp');
    const certFd = fs.openSync(certTmp, 'w');
    try {
      fs.writeSync(certFd, JSON.stringify(cert, null, 2));
      fsyncFile(certFd);
    } finally {
      fs.closeSync(certFd);
    }
    fs.renameSync(certTmp, path.join(this.certDir, batchId + '.json'));
    fsyncDir(this.certDir);

    // Phase 4: update the secondary index, then clear the WAL.
    for (const rec of stored) {
      (this.index.bySubmitter[rec.submitter] ||= []).push(rec.id);
      this.index.byTime.push({ timestamp: rec.timestamp, id: rec.id });
    }
    this.index.byTime.sort((a, b) => a.timestamp - b.timestamp);
    this._writeIndex();
    fs.unlinkSync(this.walPath);
    fsyncDir(this.dir);

    return cert;
  }

  // ---- reads ----------------------------------------------------------------

  // Read a record by evidence id and immediately re-verify its hash.
  get(id) {
    const { records } = this._scan();
    for (const { offset, record } of records) {
      if (record.id !== id) continue;
      const expected = computeRecordHash(record.prevHash, record);
      if (expected !== record.hash) {
        throw new StoreError('TAMPER', `hash mismatch for record ${id} at offset ${offset}`, {
          offset,
          recordId: id,
        });
      }
      return record;
    }
    return null;
  }

  // Secondary-index lookup: filter by submitter and/or timestamp range (ms).
  list({ submitter, from, to } = {}) {
    let ids = null;
    if (submitter !== undefined) {
      ids = new Set(this.index.bySubmitter[submitter] || []);
    }
    if (from !== undefined || to !== undefined) {
      const inRange = new Set(
        this.index.byTime
          .filter((e) => (from === undefined || e.timestamp >= from) && (to === undefined || e.timestamp <= to))
          .map((e) => e.id)
      );
      ids = ids === null ? inRange : new Set([...ids].filter((id) => inRange.has(id)));
    }
    const { records } = this._scan();
    const out = [];
    for (const { record } of records) {
      if (ids === null || ids.has(record.id)) out.push(record);
    }
    return out;
  }

  // ---- verification ---------------------------------------------------------

  // Replay the whole log: recompute every record hash, check chain
  // continuity, and check each batch against its certificate.
  verify() {
    const { records } = this._scan();
    let prevHash = GENESIS_HASH;
    const batches = new Map();
    for (const { offset, record } of records) {
      if (record.prevHash !== prevHash) {
        throw new StoreError(
          'TAMPER',
          `chain discontinuity at offset ${offset} (record ${record.id})`,
          { offset, recordId: record.id }
        );
      }
      const expected = computeRecordHash(prevHash, record);
      if (expected !== record.hash) {
        throw new StoreError(
          'TAMPER',
          `hash mismatch at offset ${offset} (record ${record.id})`,
          { offset, recordId: record.id }
        );
      }
      prevHash = record.hash;
      if (!batches.has(record.batchId)) batches.set(record.batchId, []);
      batches.get(record.batchId).push(record);
    }

    const certs = this._loadCerts();
    const certByBatch = new Map(certs.map((c) => [c.batchId, c]));
    const batchReports = [];
    for (const [batchId, recs] of batches) {
      const cert = certByBatch.get(batchId);
      if (!cert) {
        throw new StoreError('NO_CERT', `no certificate for committed batch ${batchId}`, { batchId });
      }
      const first = recs[0];
      const last = recs[recs.length - 1];
      if (
        cert.recordCount !== recs.length ||
        cert.prevChainHead !== first.prevHash ||
        cert.chainHead !== last.hash
      ) {
        throw new StoreError('TAMPER', `certificate mismatch for batch ${batchId}`, { batchId });
      }
      batchReports.push({ batchId, recordCount: recs.length, chainHead: cert.chainHead });
    }
    // Certificates with no corresponding records are also an inconsistency.
    for (const cert of certs) {
      if (!batches.has(cert.batchId)) {
        throw new StoreError('TAMPER', `certificate ${cert.batchId} has no records in data.log`, {
          batchId: cert.batchId,
        });
      }
    }

    return {
      ok: true,
      recordCount: records.length,
      batchCount: batches.size,
      chainHead: prevHash,
      batches: batchReports,
    };
  }

  // Export the certificate for one commit.
  cert(batchId) {
    const p = path.join(this.certDir, batchId + '.json');
    if (!fs.existsSync(p)) {
      throw new StoreError('NO_CERT', `no certificate for batch ${batchId}`, { batchId });
    }
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  }
}

module.exports = { EvidenceStore, StoreError, GENESIS_HASH, computeRecordHash };
