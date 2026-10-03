import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const CRASH_POINTS = Object.freeze(['beforeRename', 'afterRename']);

export class LedgerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
  }
}

export class CrashSimulated extends Error {
  constructor(point) {
    super(`simulated crash at ${point}`);
    this.name = 'CrashSimulated';
    this.point = point;
  }
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function compareEntryId(a, b) {
  return a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0;
}

export function canonicalEntries(entries) {
  return [...entries.values()].map((e) => ({ ...e })).sort(compareEntryId);
}

export function stateHash(entries) {
  return sha256(JSON.stringify({ version: 1, entries: canonicalEntries(entries) }));
}

function fsyncDir(dir) {
  const fd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function writeFileFsync(file, data) {
  const fd = fs.openSync(file, 'w');
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export class LedgerStore {
  constructor(file, { crashPoint = null, crashMode = 'throw' } = {}) {
    this.file = file;
    this.tmpFile = `${file}.tmp`;
    this.watermarkFile = `${file}.watermark`;
    this.logFile = `${file}.log`;
    this.crashPoint = crashPoint;
    this.crashMode = crashMode; // 'throw' for in-process tests, 'exit' for real process crash
    this.entries = new Map();
    this.seq = 0;
  }

  #crash(point) {
    if (this.crashPoint !== point) return;
    if (this.crashMode === 'exit') process.exit(75);
    throw new CrashSimulated(point);
  }

  #appendLog(record) {
    this.seq += 1;
    const line = `${JSON.stringify({ seq: this.seq, ...record })}\n`;
    const fd = fs.openSync(this.logFile, 'a');
    try {
      fs.writeSync(fd, line);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  #readLog() {
    if (!fs.existsSync(this.logFile)) return [];
    const lines = fs.readFileSync(this.logFile, 'utf8').split('\n').filter((l) => l.length > 0);
    const records = [];
    for (let i = 0; i < lines.length; i += 1) {
      try {
        records.push(JSON.parse(lines[i]));
      } catch (err) {
        if (i === lines.length - 1) break; // tolerate torn tail from a crash
        throw new LedgerError('LOG_CORRUPT', `changelog corrupt at line ${i + 1}`);
      }
    }
    return records;
  }

  #readWatermark() {
    if (!fs.existsSync(this.watermarkFile)) return { ok: false, reason: 'missing' };
    try {
      const wm = JSON.parse(fs.readFileSync(this.watermarkFile, 'utf8'));
      if (typeof wm.snapshotHash !== 'string' || !Number.isSafeInteger(wm.logSeq)) {
        return { ok: false, reason: 'invalid-fields' };
      }
      return { ok: true, value: wm };
    } catch {
      return { ok: false, reason: 'corrupt' };
    }
  }

  #readSnapshot(expectedHash) {
    if (!fs.existsSync(this.file)) return { ok: false, reason: 'missing' };
    const raw = fs.readFileSync(this.file);
    if (sha256(raw) !== expectedHash) return { ok: false, reason: 'hash-mismatch' };
    try {
      const snap = JSON.parse(raw.toString('utf8'));
      if (!Array.isArray(snap.entries)) return { ok: false, reason: 'invalid' };
      return { ok: true, entries: snap.entries };
    } catch {
      return { ok: false, reason: 'corrupt' };
    }
  }

  #apply(record) {
    if (record.op === 'submit') {
      if (!this.entries.has(record.entry.entryId)) {
        this.entries.set(record.entry.entryId, { ...record.entry });
      }
    } else if (record.op === 'cancel') {
      const e = this.entries.get(record.entryId);
      if (e && e.status === 'pending') e.status = 'cancelled';
    } else if (record.op === 'settle') {
      for (const id of record.settledIds) {
        const e = this.entries.get(id);
        if (e && e.status === 'pending') e.status = 'settled';
      }
    } else {
      throw new LedgerError('LOG_CORRUPT', `unknown op ${record.op}`);
    }
  }

  recover() {
    this.entries = new Map();
    this.seq = 0;
    let fromSeq = 0;
    const wm = this.#readWatermark();
    if (wm.ok) {
      const snap = this.#readSnapshot(wm.value.snapshotHash);
      if (snap.ok) {
        for (const e of snap.entries) this.entries.set(e.entryId, { ...e });
        fromSeq = wm.value.logSeq;
      }
    }
    // Corrupt/missing watermark or snapshot: ignore snapshot, replay full changelog.
    for (const record of this.#readLog()) {
      if (record.seq <= fromSeq) continue;
      this.#apply(record);
      if (record.seq > this.seq) this.seq = record.seq;
    }
    if (fromSeq > this.seq) this.seq = fromSeq;
    return this.snapshot();
  }

  submit({ entryId, payer, payee, amount }) {
    if (typeof entryId !== 'string' || entryId.length === 0) {
      throw new LedgerError('INVALID_ENTRY', 'entryId must be a non-empty string');
    }
    if (typeof payer !== 'string' || payer.length === 0
        || typeof payee !== 'string' || payee.length === 0) {
      throw new LedgerError('INVALID_ENTRY', 'payer/payee must be non-empty strings');
    }
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new LedgerError('INVALID_ENTRY', 'amount must be a positive safe integer');
    }
    const existing = this.entries.get(entryId);
    if (existing) return existing; // idempotent duplicate submission
    const entry = { entryId, payer, payee, amount, status: 'pending' };
    this.#appendLog({ op: 'submit', entry });
    this.entries.set(entryId, entry);
    return entry;
  }

  cancel(entryId) {
    const e = this.entries.get(entryId);
    if (!e) throw new LedgerError('ENTRY_NOT_FOUND', `no entry ${entryId}`);
    if (e.status !== 'pending') {
      throw new LedgerError('ENTRY_NOT_PENDING', `entry ${entryId} is ${e.status}`);
    }
    this.#appendLog({ op: 'cancel', entryId });
    e.status = 'cancelled';
    return e;
  }

  computeNets() {
    const nets = new Map();
    for (const e of this.entries.values()) {
      if (e.status !== 'pending') continue;
      nets.set(e.payer, (nets.get(e.payer) ?? 0) - e.amount);
      nets.set(e.payee, (nets.get(e.payee) ?? 0) + e.amount);
    }
    return Object.fromEntries([...nets.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
  }

  settle() {
    const pending = [...this.entries.values()].filter((e) => e.status === 'pending');
    const settledIds = pending.map((e) => e.entryId);
    const nets = this.computeNets();

    const next = new Map();
    for (const e of this.entries.values()) {
      next.set(e.entryId, { ...e, status: e.status === 'pending' ? 'settled' : e.status });
    }
    const snapshotPayload = { version: 1, logSeq: this.seq + 1, entries: canonicalEntries(next) };
    const snapshotBytes = JSON.stringify(snapshotPayload);
    const snapshotHash = sha256(snapshotBytes);

    // 1. temp snapshot + fsync
    writeFileFsync(this.tmpFile, snapshotBytes);
    this.#crash('beforeRename');
    // 2. atomic rename + dir fsync
    fs.renameSync(this.tmpFile, this.file);
    fsyncDir(path.dirname(path.resolve(this.file)));
    // 3. commit settle to the durable changelog
    this.#appendLog({ op: 'settle', settledIds, nets });
    this.#crash('afterRename');
    // 4. durable watermark
    writeFileFsync(this.watermarkFile, JSON.stringify({ snapshotHash, logSeq: this.seq }));
    fsyncDir(path.dirname(path.resolve(this.file)));

    this.entries = next;
    return { nets, settledIds, recoveryHash: stateHash(this.entries) };
  }

  snapshot() {
    return { entries: canonicalEntries(this.entries), recoveryHash: stateHash(this.entries) };
  }

  recoveryHash() {
    return stateHash(this.entries);
  }
}
