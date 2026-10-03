// Persistence layer: append-only journal + per-task lease files committed via
// write-tmp-then-rename. Crash injection points:
//   after-tmp-write : lease.tmp written+fsynced, no rename yet
//   before-rename   : same on-disk state, crash right at the rename boundary
//   after-rename    : rename done (new lease authoritative), journal not appended
// Recovery:
//   - orphan *.tmp files are discarded (rename never happened -> old lease stands)
//   - a committed lease newer than the journal is adopted into the journal
//   - a committed lease older than the journal is regenerated from the journal
// In all three cases at most one lease record is authoritative per task, so
// no double ownership can survive a restart.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Engine } from './engine.js';

export const EXIT = {
  OK: 0,
  AUDIT_VIOLATION: 1,
  USAGE: 2,
  STALE: 8,
  PERSIST: 9,
  CRASH: 70,
};

export const CRASH_POINTS = ['after-tmp-write', 'before-rename', 'after-rename'];

export class PersistenceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PersistenceError';
    this.exitCode = EXIT.PERSIST;
  }
}

export class CrashInjected extends Error {
  constructor(point) {
    super(`crash injected at ${point}`);
    this.name = 'CrashInjected';
    this.point = point;
    this.exitCode = EXIT.CRASH;
  }
}

const LEASE_STATUSES = new Set(['active', 'revoked', 'completed']);

function checksumOf(record) {
  const { checksum, ...rest } = record;
  return crypto.createHash('sha256').update(JSON.stringify(rest)).digest('hex');
}

function validateLeaseShape(rec, where) {
  if (!rec || typeof rec !== 'object') throw new PersistenceError(`${where}: lease is not an object`);
  if (typeof rec.task !== 'string' || rec.task.length === 0) {
    throw new PersistenceError(`${where}: lease.task missing`);
  }
  if (rec.holder !== null && typeof rec.holder !== 'string') {
    throw new PersistenceError(`${where}: lease.holder invalid`);
  }
  if (!Number.isInteger(rec.epoch) || rec.epoch < 0) {
    throw new PersistenceError(`${where}: lease.epoch invalid`);
  }
  if (typeof rec.expiry !== 'number' || !Number.isFinite(rec.expiry)) {
    throw new PersistenceError(`${where}: lease.expiry invalid`);
  }
  if (!LEASE_STATUSES.has(rec.status)) throw new PersistenceError(`${where}: lease.status invalid`);
  if (!Number.isInteger(rec.tseq) || rec.tseq < 1) throw new PersistenceError(`${where}: lease.tseq invalid`);
}

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.leasesDir = path.join(dir, 'leases');
    this.journalPath = path.join(dir, 'events.jsonl');
  }

  static init(dir) {
    fs.mkdirSync(path.join(dir, 'leases'), { recursive: true });
    const store = new Store(dir);
    if (!fs.existsSync(store.journalPath)) fs.writeFileSync(store.journalPath, '');
    return store;
  }

  leaseFile(task) {
    return path.join(this.leasesDir, `${encodeURIComponent(task)}.json`);
  }

  commitLease(record, crashPoint) {
    if (crashPoint && !CRASH_POINTS.includes(crashPoint)) {
      throw new PersistenceError(`unknown crash point: ${crashPoint}`);
    }
    const full = { ...record, checksum: checksumOf(record) };
    const file = this.leaseFile(record.task);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(full)}\n`);
    const fd = fs.openSync(tmp, 'r+');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    if (crashPoint === 'after-tmp-write') throw new CrashInjected(crashPoint);
    if (crashPoint === 'before-rename') throw new CrashInjected(crashPoint);
    fs.renameSync(tmp, file);
    if (crashPoint === 'after-rename') throw new CrashInjected(crashPoint);
    return full;
  }

  appendJournal(line) {
    fs.appendFileSync(this.journalPath, `${JSON.stringify(line)}\n`);
  }

  readJournal() {
    const ops = [];
    if (!fs.existsSync(this.journalPath)) return ops;
    const text = fs.readFileSync(this.journalPath, 'utf8');
    let seq = 0;
    for (const raw of text.split('\n')) {
      if (!raw.trim()) continue;
      seq += 1;
      let obj;
      try {
        obj = JSON.parse(raw);
      } catch {
        throw new PersistenceError(`journal line ${seq}: invalid JSON`);
      }
      if (!obj || typeof obj !== 'object') {
        throw new PersistenceError(`journal line ${seq}: not an object`);
      }
      if (obj.seq !== seq) {
        throw new PersistenceError(`journal line ${seq}: seq mismatch (found ${obj.seq})`);
      }
      if (!obj.ev || typeof obj.ev !== 'object') {
        throw new PersistenceError(`journal line ${seq}: missing event`);
      }
      if (obj.lease) validateLeaseShape(obj.lease, `journal line ${seq}`);
      ops.push(obj);
    }
    const maxEpoch = new Map();
    for (const op of ops) {
      if (op.lease && op.lease.status === 'active') {
        const prev = maxEpoch.get(op.lease.task) ?? 0;
        if (op.lease.epoch < prev) {
          throw new PersistenceError(
            `journal: fencing epoch regression on task ${op.lease.task} (${op.lease.epoch} < ${prev})`,
          );
        }
        maxEpoch.set(op.lease.task, op.lease.epoch);
      }
    }
    return ops;
  }

  readLeaseFile(task) {
    const file = this.leaseFile(task);
    if (!fs.existsSync(file)) return null;
    let rec;
    try {
      rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      throw new PersistenceError(`lease file ${file}: invalid JSON`);
    }
    validateLeaseShape(rec, `lease file ${file}`);
    if (typeof rec.checksum !== 'string' || rec.checksum !== checksumOf(rec)) {
      throw new PersistenceError(`lease file ${file}: checksum mismatch`);
    }
    return rec;
  }

  recover() {
    const report = [];
    for (const name of fs.readdirSync(this.leasesDir).sort()) {
      if (name.endsWith('.tmp')) {
        fs.rmSync(path.join(this.leasesDir, name), { force: true });
        report.push({ op: 'discard-tmp', file: name });
      }
    }
    const ops = this.readJournal();
    let nextSeq = ops.length + 1;
    const journalLease = new Map();
    for (const op of ops) if (op.lease) journalLease.set(op.lease.task, op.lease);

    const seen = new Set();
    for (const name of fs.readdirSync(this.leasesDir).sort()) {
      if (!name.endsWith('.json')) continue;
      const task = decodeURIComponent(name.slice(0, -'.json'.length));
      seen.add(task);
      const rec = this.readLeaseFile(task);
      const journaled = journalLease.get(task);
      const journalTseq = journaled ? journaled.tseq : 0;
      if (rec.tseq > journalTseq) {
        // Crash after rename: committed lease is authoritative, adopt it.
        const { checksum, ...clean } = rec;
        const line = { seq: nextSeq, tseq: rec.tseq, ev: { type: 'adopt', task, ts: rec.ts ?? 0 }, lease: clean };
        nextSeq += 1;
        this.appendJournal(line);
        ops.push(line);
        journalLease.set(task, clean);
        report.push({ op: 'adopt-lease', task, epoch: rec.epoch, status: rec.status, holder: rec.holder });
      } else if (rec.tseq < journalTseq) {
        // Journal is newer: regenerate the lease file from the journal.
        this.commitLease({ ...journaled });
        report.push({ op: 'restore-lease', task, epoch: journaled.epoch });
      }
    }
    for (const [task, journaled] of journalLease) {
      if (!seen.has(task)) {
        this.commitLease({ ...journaled });
        report.push({ op: 'restore-lease', task, epoch: journaled.epoch });
      }
    }
    report.push({ op: 'validate', ok: true });
    return report;
  }

  load() {
    this.recover();
    const engine = new Engine();
    const ops = this.readJournal();
    const tseq = new Map();
    for (const op of ops) {
      if (op.lease) {
        const current = tseq.get(op.lease.task) ?? 0;
        if (op.lease.tseq > current) tseq.set(op.lease.task, op.lease.tseq);
      }
      if (op.ev.type === 'adopt') engine.applyLeaseRecord(op.lease);
      else engine.applyEvent(op.ev);
    }
    return new Scheduler(this, engine, tseq, ops.length + 1);
  }
}

export class Scheduler {
  constructor(store, engine, tseq, nextSeq) {
    this.store = store;
    this.engine = engine;
    this.tseq = tseq;
    this.nextSeq = nextSeq;
  }

  static open(dir) {
    return Store.init(dir).load();
  }

  applyEvent(ev, opts = {}) {
    const res = this.engine.applyEvent(ev);
    if (res.lease) {
      const taskId = res.lease.task;
      const tseq = (this.tseq.get(taskId) ?? 0) + 1;
      const record = { ...res.lease, tseq, ts: typeof ev.ts === 'number' ? ev.ts : 0 };
      // Lease commits before the journal append; a crash between the two is
      // exactly the "after-rename" injection point handled by recover().
      this.store.commitLease(record, opts.crashPoint);
      this.store.appendJournal({ seq: this.nextSeq, tseq, ev, lease: record });
      this.nextSeq += 1;
      this.tseq.set(taskId, tseq);
    } else if (res.journal) {
      this.store.appendJournal({ seq: this.nextSeq, ev });
      this.nextSeq += 1;
    }
    return res;
  }

  summary() {
    return this.engine.summary();
  }
}
