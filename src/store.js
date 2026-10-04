import fs from 'node:fs';
import path from 'node:path';
import { BusinessError, CorruptionError } from './errors.js';
import { DEFAULT_CATALOG, judge, loadCatalog, validateCatalog } from './catalog.js';
import { Wal } from './wal.js';
import { certificateFor, computeRecordHash, verifyCertificateData } from './certs.js';
import { GENESIS_HASH, atomicWriteFileSync, canonical, newRecordId, sha256 } from './util.js';

export function indexKey(lotId, testCode) {
  return `${lotId} ${testCode}`;
}

function emptyState() {
  return {
    lastSeq: 0,
    lastHash: GENESIS_HASH,
    byClientId: {},
    byKey: {},
    records: {},
  };
}

function payloadHashOf(rec) {
  return sha256(canonical({
    type: rec.type,
    lotId: rec.lotId,
    testCode: rec.testCode,
    value: rec.value,
    correctsRecordId: rec.correctsRecordId ?? null,
  }));
}

export function initDb(dir, catalog) {
  if (fs.existsSync(path.join(dir, 'wal.log'))) {
    throw new BusinessError('ERR_ALREADY_INITIALIZED', `database already initialized at ${dir}`);
  }
  fs.mkdirSync(path.join(dir, 'certs'), { recursive: true });
  const cat = catalog ?? DEFAULT_CATALOG;
  validateCatalog(cat);
  atomicWriteFileSync(path.join(dir, 'catalog.json'), `${JSON.stringify(cat, null, 2)}\n`);
  atomicWriteFileSync(path.join(dir, 'state.json'), JSON.stringify(emptyState()));
  fs.closeSync(fs.openSync(path.join(dir, 'wal.log'), 'a'));
  return { dir, catalog: Object.keys(cat) };
}

export class QualityStore {
  static open(dir, opts = {}) {
    return new QualityStore(dir, opts);
  }

  constructor(dir, opts = {}) {
    this.dir = dir;
    this.fault = opts.fault ?? process.env.QCS_FAULT ?? null;
    this.catalog = loadCatalog(dir);
    this.wal = new Wal(path.join(dir, 'wal.log'));
    this.certsDir = path.join(dir, 'certs');
    this.stateFile = path.join(dir, 'state.json');
    this.recovered = this._recover();
  }

  _loadSnapshot() {
    if (!fs.existsSync(this.stateFile)) return null;
    let snap;
    try {
      snap = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
    } catch {
      throw new CorruptionError('state.json is not valid JSON');
    }
    if (typeof snap?.lastSeq !== 'number' || typeof snap?.lastHash !== 'string'
        || snap.byClientId === undefined || snap.byKey === undefined || snap.records === undefined) {
      throw new CorruptionError('state.json has an invalid shape');
    }
    return snap;
  }

  _recover() {
    const { committed, discarded, committedBytes } = this.wal.scan();
    this.wal.truncateTo(committedBytes);
    const snap = this._loadSnapshot();
    const snapSeq = snap ? snap.lastSeq : 0;
    if (snap && snapSeq > committed.length) {
      throw new CorruptionError(`state.json (seq ${snapSeq}) is ahead of WAL (${committed.length} committed)`);
    }
    this.state = snap ?? emptyState();
    let prevHash = GENESIS_HASH;
    let expectedSeq = 1;
    for (const { record, hash } of committed) {
      if (record.seq !== expectedSeq) {
        throw new CorruptionError(`WAL seq gap: expected ${expectedSeq}, found ${record.seq}`);
      }
      if (record.prevHash !== prevHash) {
        throw new CorruptionError(`WAL hash chain broken at seq ${record.seq}`);
      }
      if (computeRecordHash(record) !== hash) {
        throw new CorruptionError(`WAL record hash mismatch at seq ${record.seq}`);
      }
      if (snap && record.seq === snapSeq && hash !== snap.lastHash) {
        throw new CorruptionError('state.json diverges from WAL');
      }
      prevHash = hash;
      expectedSeq += 1;
      if (record.seq > snapSeq) this._apply(record, hash);
    }
    for (const rec of Object.values(this.state.records)) this._ensureCert(rec);
    if (this.state.lastSeq !== committed.length || !snap) this._persistSnapshot();
    return { committed: committed.length, discarded, lastSeq: this.state.lastSeq };
  }

  _apply(record, hash) {
    const rec = { ...record, hash };
    if (rec.type === 'correct') {
      const target = this.state.records[rec.correctsRecordId];
      if (!target) {
        throw new CorruptionError(`committed correction ${rec.recordId} references unknown record ${rec.correctsRecordId}`);
      }
      target.invalidatedBy = rec.recordId;
    }
    this.state.records[rec.recordId] = rec;
    this.state.byClientId[rec.clientRecordId] = { recordId: rec.recordId, payloadHash: payloadHashOf(rec) };
    const key = indexKey(rec.lotId, rec.testCode);
    (this.state.byKey[key] ??= []).push(rec.recordId);
    this.state.lastSeq = rec.seq;
    this.state.lastHash = hash;
  }

  _persistSnapshot() {
    atomicWriteFileSync(this.stateFile, JSON.stringify(this.state));
  }

  _certFile(recordId) {
    return path.join(this.certsDir, `${recordId}.json`);
  }

  _ensureCert(rec) {
    const file = this._certFile(rec.recordId);
    if (fs.existsSync(file)) return;
    atomicWriteFileSync(file, JSON.stringify(certificateFor(rec, rec.hash), null, 2));
  }

  _commit({ clientRecordId, type, lotId, testCode, value, correctsRecordId = null, judgment, reportedAt }) {
    const record = {
      seq: this.state.lastSeq + 1,
      recordId: newRecordId(),
      clientRecordId,
      type,
      lotId,
      testCode,
      value,
      correctsRecordId,
      judgment,
      reportedAt: reportedAt ?? Date.now(),
      prevHash: this.state.lastHash,
    };
    const hash = computeRecordHash(record);
    this.wal.appendCommitted(record, hash, this.fault);
    this._apply(record, hash);
    this._persistSnapshot();
    this._ensureCert(this.state.records[record.recordId]);
    return this.state.records[record.recordId];
  }

  _dedup(clientRecordId, payloadHash) {
    const existing = this.state.byClientId[clientRecordId];
    if (!existing) return null;
    if (existing.payloadHash !== payloadHash) {
      throw new BusinessError(
        'ERR_CLIENT_ID_CONFLICT',
        `clientRecordId ${clientRecordId} already used with a different payload`,
      );
    }
    return this.state.records[existing.recordId];
  }

  report(input) {
    const { clientRecordId, lotId, testCode, value, reportedAt } = input ?? {};
    for (const [name, v] of [['clientRecordId', clientRecordId], ['lotId', lotId], ['testCode', testCode]]) {
      if (typeof v !== 'string' || v === '') {
        throw new BusinessError('ERR_MISSING_FIELD', `missing or invalid field: ${name}`);
      }
    }
    if (value === undefined || value === null) {
      throw new BusinessError('ERR_MISSING_FIELD', 'missing or invalid field: value');
    }
    const item = this.catalog[testCode];
    if (!item) {
      throw new BusinessError('ERR_UNKNOWN_TEST', `unknown testCode: ${testCode}`, { testCode });
    }
    const judgment = judge(value, item, testCode);
    const dup = this._dedup(clientRecordId, payloadHashOf({ type: 'measure', lotId, testCode, value }));
    if (dup) return { record: dup, deduplicated: true };
    const record = this._commit({ clientRecordId, type: 'measure', lotId, testCode, value, judgment, reportedAt });
    return { record, deduplicated: false };
  }

  correct(input) {
    const { clientRecordId, correctsRecordId, value, reportedAt } = input ?? {};
    for (const [name, v] of [['clientRecordId', clientRecordId], ['correctsRecordId', correctsRecordId]]) {
      if (typeof v !== 'string' || v === '') {
        throw new BusinessError('ERR_MISSING_FIELD', `missing or invalid field: ${name}`);
      }
    }
    if (value === undefined || value === null) {
      throw new BusinessError('ERR_MISSING_FIELD', 'missing or invalid field: value');
    }
    const target = this.state.records[correctsRecordId];
    if (!target) {
      throw new BusinessError('ERR_UNKNOWN_REFERENCE', `unknown record referenced: ${correctsRecordId}`, { correctsRecordId });
    }
    if (target.invalidatedBy) {
      throw new BusinessError('ERR_ALREADY_CORRECTED', `record ${correctsRecordId} already corrected by ${target.invalidatedBy}`);
    }
    const item = this.catalog[target.testCode];
    if (!item) {
      throw new BusinessError('ERR_UNKNOWN_TEST', `unknown testCode: ${target.testCode}`, { testCode: target.testCode });
    }
    const judgment = judge(value, item, target.testCode);
    const dup = this._dedup(clientRecordId, payloadHashOf({
      type: 'correct', lotId: target.lotId, testCode: target.testCode, value, correctsRecordId,
    }));
    if (dup) return { record: dup, deduplicated: true };
    const record = this._commit({
      clientRecordId,
      type: 'correct',
      lotId: target.lotId,
      testCode: target.testCode,
      value,
      correctsRecordId,
      judgment,
      reportedAt,
    });
    return { record, deduplicated: false };
  }

  _headOf(key) {
    const ids = this.state.byKey[key];
    if (!ids) return null;
    for (let i = ids.length - 1; i >= 0; i -= 1) {
      const rec = this.state.records[ids[i]];
      if (rec && !rec.invalidatedBy) return rec;
    }
    return null;
  }

  status(lotId, testCode) {
    const key = indexKey(lotId, testCode);
    const total = (this.state.byKey[key] ?? []).length;
    const head = this._headOf(key);
    if (!head) return { lotId, testCode, judgment: 'NO_DATA', head: null, totalRecords: total };
    return { lotId, testCode, judgment: head.judgment, head: publicRecord(head), totalRecords: total };
  }

  history(lotId, testCode) {
    const key = indexKey(lotId, testCode);
    const ids = this.state.byKey[key] ?? [];
    return {
      lotId,
      testCode,
      records: ids.map((id) => publicRecord(this.state.records[id])),
    };
  }

  projection() {
    const heads = {};
    for (const key of Object.keys(this.state.byKey)) {
      const head = this._headOf(key);
      if (head) heads[key] = { recordId: head.recordId, judgment: head.judgment, seq: head.seq };
    }
    return {
      lastSeq: this.state.lastSeq,
      lastHash: this.state.lastHash,
      heads,
      recordCount: Object.keys(this.state.records).length,
      clientCount: Object.keys(this.state.byClientId).length,
    };
  }

  verifyCertificate(recordId) {
    const file = this._certFile(recordId);
    if (!fs.existsSync(file)) {
      throw new BusinessError('ERR_UNKNOWN_REFERENCE', `no certificate for record ${recordId}`);
    }
    let cert;
    try {
      cert = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      throw new CorruptionError(`certificate for ${recordId} is not valid JSON`);
    }
    const result = verifyCertificateData(cert);
    if (!result.valid) throw new CorruptionError(`certificate for ${recordId} invalid: ${result.reason}`);
    return { recordId, valid: true, judgment: cert.judgment, hash: cert.hash };
  }

  verifyChain() {
    const { committed } = this.wal.scan();
    let prevHash = GENESIS_HASH;
    let checked = 0;
    for (const { record, hash } of committed) {
      if (record.prevHash !== prevHash || computeRecordHash(record) !== hash) {
        throw new CorruptionError(`certificate chain broken at seq ${record.seq}`);
      }
      this.verifyCertificate(record.recordId);
      prevHash = hash;
      checked += 1;
    }
    return { ok: true, checked, lastHash: prevHash };
  }
}

export function publicRecord(rec) {
  return {
    seq: rec.seq,
    recordId: rec.recordId,
    clientRecordId: rec.clientRecordId,
    type: rec.type,
    lotId: rec.lotId,
    testCode: rec.testCode,
    value: rec.value,
    judgment: rec.judgment,
    correctsRecordId: rec.correctsRecordId ?? null,
    invalidatedBy: rec.invalidatedBy ?? null,
    reportedAt: rec.reportedAt,
    prevHash: rec.prevHash,
    hash: rec.hash,
  };
}
