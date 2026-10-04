import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  LedgerError,
  createState,
  applySubmit,
  applyCancel,
  applySettle,
  pendingEntries,
  stateHash,
} from './ledger.js';

export class CrashError extends Error {
  constructor(point) {
    super(`simulated crash at ${point}`);
    this.name = 'CrashError';
    this.point = point;
  }
}

export const CRASH_POINTS = Object.freeze([
  'settle:beforeRename',
  'settle:afterRename',
]);

const LOG_FILE = 'ledger.log';
const SNAP_FILE = 'ledger.snap';
const SNAP_TMP_FILE = 'ledger.snap.tmp';
const WM_FILE = 'ledger.wm';

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function tryRead(filePath) {
  try {
    return fs.readFileSync(filePath);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function fsyncDir(dir) {
  const fd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function writeTmpAndFsync(tmpPath, data) {
  const fd = fs.openSync(tmpPath, 'w');
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function readLog(logPath) {
  const raw = tryRead(logPath);
  if (!raw) return { records: [], tornTail: false };
  const records = [];
  let tornTail = false;
  for (const line of raw.toString('utf8').split('\n')) {
    if (line === '') continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      tornTail = true;
      break;
    }
    if (!Number.isSafeInteger(record.seq) || typeof record.type !== 'string') {
      tornTail = true;
      break;
    }
    records.push(record);
  }
  return { records, tornTail };
}

function applyRecord(state, record) {
  switch (record.type) {
    case 'submit':
      applySubmit(state, record.entry);
      break;
    case 'cancel':
      applyCancel(state, record);
      break;
    case 'settle':
      applySettle(state);
      break;
    default:
      throw new LedgerError('LOG_CORRUPT', `unknown log record type: ${record.type}`);
  }
}

export function recoverFromDisk(baseDir) {
  const logPath = path.join(baseDir, LOG_FILE);
  const snapPath = path.join(baseDir, SNAP_FILE);
  const wmPath = path.join(baseDir, WM_FILE);

  const { records, tornTail } = readLog(logPath);

  let state = createState();
  let fromSeq = 0;
  let source;

  let watermark = null;
  const wmRaw = tryRead(wmPath);
  if (wmRaw) {
    try {
      watermark = JSON.parse(wmRaw.toString('utf8'));
    } catch {
      watermark = null;
    }
  }
  const watermarkValid =
    watermark &&
    Number.isSafeInteger(watermark.seq) &&
    typeof watermark.snapHash === 'string';

  if (!watermarkValid) {
    source = 'log-only:watermark-missing-or-corrupt';
  } else {
    const snapRaw = tryRead(snapPath);
    if (snapRaw && sha256(snapRaw) === watermark.snapHash) {
      try {
        const snapshot = JSON.parse(snapRaw.toString('utf8'));
        state = snapshot.state;
        fromSeq = watermark.seq;
        source = 'snapshot+log';
      } catch {
        source = 'log-only:snapshot-unparseable';
      }
    } else {
      source = 'log-only:snapshot-corrupt';
    }
  }

  let seq = fromSeq;
  for (const record of records) {
    if (record.seq <= fromSeq) continue;
    applyRecord(state, record);
    seq = record.seq;
  }

  return { state, seq, source, tornTail, recoveryHash: stateHash(state) };
}

export class Store {
  constructor(baseDir, { onCrashPoint } = {}) {
    this.baseDir = baseDir;
    this.logPath = path.join(baseDir, LOG_FILE);
    this.snapPath = path.join(baseDir, SNAP_FILE);
    this.snapTmpPath = path.join(baseDir, SNAP_TMP_FILE);
    this.wmPath = path.join(baseDir, WM_FILE);
    this.onCrashPoint = onCrashPoint ?? (() => {});
    fs.mkdirSync(baseDir, { recursive: true });
    const recovered = recoverFromDisk(baseDir);
    this.state = recovered.state;
    this.seq = recovered.seq;
    this.recoverySource = recovered.source;
  }

  crashPoint(point) {
    this.onCrashPoint(point);
  }

  appendLog(record) {
    this.seq += 1;
    const full = { seq: this.seq, ...record };
    const fd = fs.openSync(this.logPath, 'a');
    try {
      fs.writeSync(fd, `${JSON.stringify(full)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return full;
  }

  submit(entry) {
    const result = applySubmit(this.state, entry);
    if (!result.changed) return result;
    this.appendLog({ type: 'submit', entry: result.entry });
    return result;
  }

  cancel(entryId) {
    const result = applyCancel(this.state, { entryId });
    this.appendLog({ type: 'cancel', entryId });
    return result;
  }

  settle() {
    if (pendingEntries(this.state).length === 0) {
      return { changed: false, settlement: null };
    }
    const { settlement } = applySettle(this.state);

    const snapData = JSON.stringify({ state: this.state });
    writeTmpAndFsync(this.snapTmpPath, snapData);

    this.crashPoint('settle:beforeRename');

    fs.renameSync(this.snapTmpPath, this.snapPath);
    fsyncDir(this.baseDir);

    this.appendLog({
      type: 'settle',
      entryIds: settlement.entryIds,
      nets: settlement.nets,
    });

    this.crashPoint('settle:afterRename');

    const watermark = { seq: this.seq, snapHash: sha256(snapData) };
    writeTmpAndFsync(`${this.wmPath}.tmp`, JSON.stringify(watermark));
    fs.renameSync(`${this.wmPath}.tmp`, this.wmPath);
    fsyncDir(this.baseDir);

    return { changed: true, settlement };
  }
}
