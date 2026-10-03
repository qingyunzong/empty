import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { canonical } from './canonical.js';
import { DEFAULT_CATALOG, validateCatalog, getTestItem, validateValue } from './catalog.js';
import { judgeValue } from './judge.js';
import { Wal, readWal } from './wal.js';
import { BusinessError, CorruptionError } from './errors.js';

export const GENESIS_HASH = '0'.repeat(64);

const CATALOG_FILE = 'catalog.json';
const WAL_FILE = 'wal.log';
const STATE_FILE = 'state.json';

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function recordHash(entry) {
  return sha256(canonical({
    seq: entry.seq,
    recordId: entry.recordId,
    prevHash: entry.prevHash,
    record: entry.record,
    judgment: entry.judgment
  }));
}

export function lotKey(lotId, testCode) {
  return JSON.stringify([lotId, testCode]);
}

function emptyState() {
  return {
    seq: 0,
    headHash: GENESIS_HASH,
    records: {},
    byClientId: {},
    latest: {},
    ngStreak: {}
  };
}

export class QmsStore {
  static init(dir, { catalog = DEFAULT_CATALOG } = {}) {
    fs.mkdirSync(dir, { recursive: true });
    const catalogPath = path.join(dir, CATALOG_FILE);
    if (!fs.existsSync(catalogPath)) {
      fs.writeFileSync(catalogPath, JSON.stringify(validateCatalog(catalog), null, 2) + '\n');
    }
    const walPath = path.join(dir, WAL_FILE);
    if (!fs.existsSync(walPath)) {
      fs.writeFileSync(walPath, '');
    }
    return QmsStore.open(dir);
  }

  static open(dir, opts = {}) {
    const store = new QmsStore(dir, opts);
    store.recover();
    return store;
  }

  constructor(dir, { crashHook = null, now = null } = {}) {
    this.dir = dir;
    this.walPath = path.join(dir, WAL_FILE);
    this.statePath = path.join(dir, STATE_FILE);
    this.catalogPath = path.join(dir, CATALOG_FILE);
    this.wal = new Wal(this.walPath);
    this.crashHook = crashHook;
    this.now = now ?? (() => new Date().toISOString());
    this.catalog = null;
    this.state = emptyState();
  }

  recover() {
    if (!fs.existsSync(this.catalogPath)) {
      throw new BusinessError('NOT_INITIALIZED', `store not initialized at ${this.dir} (missing ${CATALOG_FILE})`);
    }
    this.catalog = validateCatalog(JSON.parse(fs.readFileSync(this.catalogPath, 'utf8')));

    let state = emptyState();
    if (fs.existsSync(this.statePath)) {
      try {
        const snap = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
        if (typeof snap.seq !== 'number' || typeof snap.headHash !== 'string' ||
            typeof snap.records !== 'object' || typeof snap.byClientId !== 'object' ||
            typeof snap.latest !== 'object' || typeof snap.ngStreak !== 'object') {
          throw new Error('bad shape');
        }
        state = snap;
      } catch {
        process.stderr.write(`warning: ignoring unreadable ${STATE_FILE}, rebuilding from WAL\n`);
        state = emptyState();
      }
    }

    const { lines } = readWal(this.walPath);
    const committed = [];
    let pending = null;
    let validBytes = 0;
    for (const { value: line, endOffset } of lines) {
      if (line.kind === 'data') {
        if (pending) {
          throw new CorruptionError(`wal: data record seq ${pending.seq} never committed before seq ${line.seq}`);
        }
        pending = line;
      } else if (line.kind === 'commit') {
        if (!pending) {
          throw new CorruptionError(`wal: commit marker for seq ${line.seq} without preceding data record`);
        }
        if (line.seq !== pending.seq || line.hash !== pending.hash) {
          throw new CorruptionError(`wal: commit marker mismatch for seq ${line.seq}`);
        }
        committed.push(pending);
        pending = null;
        validBytes = endOffset;
      } else {
        throw new CorruptionError(`wal: unknown line kind ${JSON.stringify(line.kind)}`);
      }
    }

    let expectSeq = 1;
    let prev = GENESIS_HASH;
    for (const entry of committed) {
      if (entry.seq !== expectSeq) {
        throw new CorruptionError(`wal: expected seq ${expectSeq}, found ${entry.seq}`);
      }
      if (entry.prevHash !== prev) {
        throw new CorruptionError(`wal: hash chain broken at seq ${entry.seq}`);
      }
      if (recordHash(entry) !== entry.hash) {
        throw new CorruptionError(`wal: hash mismatch at seq ${entry.seq}`);
      }
      prev = entry.hash;
      expectSeq += 1;
    }

    if (state.seq > committed.length) {
      throw new CorruptionError(`state snapshot seq ${state.seq} ahead of committed WAL length ${committed.length}`);
    }
    if (state.seq > 0 && committed[state.seq - 1].hash !== state.headHash) {
      throw new CorruptionError(`state snapshot head hash does not match WAL at seq ${state.seq}`);
    }

    for (const entry of committed) {
      if (entry.seq > state.seq) {
        this._applyCommitted(state, entry);
      }
    }
    this.state = state;

    if (pending) {
      this.wal.truncateTo(validBytes);
    }
  }

  _applyCommitted(state, entry) {
    const { record, judgment } = entry;
    const key = lotKey(record.lotId, record.testCode);
    state.records[entry.recordId] = {
      seq: entry.seq,
      recordId: entry.recordId,
      prevHash: entry.prevHash,
      hash: entry.hash,
      record,
      judgment
    };
    state.byClientId[record.clientRecordId] = entry.recordId;
    state.latest[key] = entry.recordId;
    state.ngStreak[key] = judgment === 'OK' ? 0 : (state.ngStreak[key] ?? 0) + 1;
    state.seq = entry.seq;
    state.headHash = entry.hash;
  }

  _crash(point) {
    if (this.crashHook) {
      this.crashHook(point);
    }
  }

  _writeSnapshot() {
    const tmp = this.statePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state));
    const fd = fs.openSync(tmp, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.statePath);
  }

  _commit(record) {
    const existing = this.state.byClientId[record.clientRecordId];
    if (existing) {
      return { duplicate: true, ...this._outcome(existing) };
    }

    if (record.type === 'correction') {
      const target = this.state.records[record.correctsRecordId];
      if (!target) {
        throw new BusinessError('UNKNOWN_RECORD', `correction references unknown recordId: ${JSON.stringify(record.correctsRecordId)}`);
      }
      record.lotId = target.record.lotId;
      record.testCode = target.record.testCode;
    }

    const item = getTestItem(this.catalog, record.testCode);
    validateValue(item, record.testCode, record.value);

    const key = lotKey(record.lotId, record.testCode);
    const { judgment } = judgeValue(item, record.value, this.state.ngStreak[key] ?? 0);

    const seq = this.state.seq + 1;
    const recordId = 'rec-' + String(seq).padStart(8, '0');
    const prevHash = this.state.headHash;
    const entry = { seq, recordId, prevHash, record, judgment };
    const hash = recordHash(entry);

    this.wal.appendLine({ kind: 'data', seq, recordId, prevHash, hash, record, judgment });
    this._crash('dataSync');
    this.wal.appendLine({ kind: 'commit', seq, hash });
    this._crash('commitSync');

    this._applyCommitted(this.state, { kind: 'data', seq, recordId, prevHash, hash, record, judgment });
    this._writeSnapshot();

    return { duplicate: false, ...this._outcome(recordId) };
  }

  _outcome(recordId) {
    const stored = this.state.records[recordId];
    return {
      recordId,
      seq: stored.seq,
      judgment: stored.judgment,
      hash: stored.hash,
      lotId: stored.record.lotId,
      testCode: stored.record.testCode
    };
  }

  report({ clientRecordId, lotId, testCode, value, measuredAt }) {
    if (typeof clientRecordId !== 'string' || clientRecordId.length === 0) {
      throw new BusinessError('INVALID_INPUT', 'clientRecordId must be a non-empty string');
    }
    if (typeof lotId !== 'string' || lotId.length === 0) {
      throw new BusinessError('INVALID_INPUT', 'lotId must be a non-empty string');
    }
    if (typeof testCode !== 'string' || testCode.length === 0) {
      throw new BusinessError('INVALID_INPUT', 'testCode must be a non-empty string');
    }
    return this._commit({
      type: 'measurement',
      clientRecordId,
      lotId,
      testCode,
      value,
      measuredAt: measuredAt ?? this.now()
    });
  }

  correct({ clientRecordId, correctsRecordId, value, measuredAt }) {
    if (typeof clientRecordId !== 'string' || clientRecordId.length === 0) {
      throw new BusinessError('INVALID_INPUT', 'clientRecordId must be a non-empty string');
    }
    if (typeof correctsRecordId !== 'string' || correctsRecordId.length === 0) {
      throw new BusinessError('INVALID_INPUT', 'correctsRecordId must be a non-empty string');
    }
    return this._commit({
      type: 'correction',
      clientRecordId,
      correctsRecordId,
      value,
      measuredAt: measuredAt ?? this.now()
    });
  }

  status(lotId, testCode) {
    const recordId = this.state.latest[lotKey(lotId, testCode)];
    if (!recordId) {
      return { lotId, testCode, judgment: null, recordId: null };
    }
    return { lotId, testCode, ...this._outcome(recordId) };
  }

  getRecord(recordId) {
    const stored = this.state.records[recordId];
    if (!stored) {
      throw new BusinessError('UNKNOWN_RECORD', `unknown recordId: ${JSON.stringify(recordId)}`);
    }
    return stored;
  }

  certificates() {
    return Object.values(this.state.records)
      .sort((a, b) => a.seq - b.seq)
      .map((stored) => ({
        recordId: stored.recordId,
        seq: stored.seq,
        lotId: stored.record.lotId,
        testCode: stored.record.testCode,
        clientRecordId: stored.record.clientRecordId,
        judgment: stored.judgment,
        prevHash: stored.prevHash,
        hash: stored.hash
      }));
  }

  verify(recordId = null) {
    const entries = Object.values(this.state.records).sort((a, b) => a.seq - b.seq);
    if (recordId !== null) {
      const stored = this.state.records[recordId];
      if (!stored) {
        throw new BusinessError('UNKNOWN_RECORD', `unknown recordId: ${JSON.stringify(recordId)}`);
      }
      if (recordHash(stored) !== stored.hash) {
        throw new CorruptionError(`certificate hash mismatch for ${recordId}`);
      }
      const expectedPrev = stored.seq === 1 ? GENESIS_HASH : entries[stored.seq - 2].hash;
      if (stored.prevHash !== expectedPrev) {
        throw new CorruptionError(`certificate prevHash mismatch for ${recordId}`);
      }
      return { ok: true, checked: 1, recordId, hash: stored.hash };
    }
    let prev = GENESIS_HASH;
    for (const stored of entries) {
      if (stored.prevHash !== prev) {
        throw new CorruptionError(`hash chain broken at seq ${stored.seq}`);
      }
      if (recordHash(stored) !== stored.hash) {
        throw new CorruptionError(`certificate hash mismatch at seq ${stored.seq}`);
      }
      prev = stored.hash;
    }
    return { ok: true, checked: entries.length, headHash: this.state.headHash };
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.state));
  }
}
