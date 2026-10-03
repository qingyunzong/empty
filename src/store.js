// Durable store: inbox -> events.log -> index.json -> lots.json/pending.json
// Exactly-once is guaranteed by reconciling events.log / index.json / lots.json
// on open(): lots.json is the committed truth, anything logged but not settled
// is replayed idempotently.
import fs from 'node:fs';
import path from 'node:path';
import { createEngine, validateEvent, compareEvents, emptyReport, collectRecord } from './engine.js';

export const FAULT_POINTS = ['before-log', 'after-log', 'before-index', 'after-index', 'before-commit', 'after-commit'];

function appendJsonl(file, obj) {
  const fd = fs.openSync(file, 'a');
  try {
    fs.writeSync(fd, JSON.stringify(obj) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function atomicWriteFile(file, data) {
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  const dfd = fs.openSync(path.dirname(file), 'r');
  try {
    fs.fsyncSync(dfd);
  } finally {
    fs.closeSync(dfd);
  }
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  return text.split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l));
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export class Store {
  constructor(dir, { windowMs = 300000, faultHook = null } = {}) {
    this.dir = dir;
    this.windowMs = windowMs;
    this.faultHook = faultHook ?? (() => {});
    this.p = {
      inbox: path.join(dir, 'inbox.log'),
      events: path.join(dir, 'events.log'),
      journal: path.join(dir, 'journal.log'),
      index: path.join(dir, 'index.json'),
      lots: path.join(dir, 'lots.json'),
      pending: path.join(dir, 'pending.json'),
      audit: path.join(dir, 'audit.log'),
    };
    this.lastRecovery = null;
  }

  fault(point, id) {
    this.faultHook(point, id);
  }

  journal(rec) {
    appendJsonl(this.p.journal, { ts: Date.now(), ...rec });
  }

  open() {
    fs.mkdirSync(this.dir, { recursive: true });
    this.engine = createEngine({ windowMs: this.windowMs });
    this.eventsById = new Map();
    this.loggedIds = [];
    for (const e of readJsonl(this.p.events)) {
      if (!this.eventsById.has(e.id)) {
        this.eventsById.set(e.id, e);
        this.loggedIds.push(e.id);
      }
    }
    const lots = readJson(this.p.lots, {});
    const pending = readJson(this.p.pending, []);
    const index = readJson(this.p.index, { rejected: [] });
    this.engine.hydrate({
      lots,
      pending,
      rejected: index.rejected ?? [],
      eventsById: this.eventsById,
      loggedOrder: this.loggedIds,
    });
    this.recover();
    return this;
  }

  recover() {
    const stats = { replayed: 0, inboxProcessed: 0, retried: 0 };
    for (const id of [...this.loggedIds]) {
      if (this.engine.isSettled(id)) continue;
      this.journal({ tx: id, phase: 'recover-replay' });
      this.processOne(this.eventsById.get(id));
      stats.replayed++;
    }
    const inbox = readJsonl(this.p.inbox);
    const seen = new Set();
    const fresh = [];
    for (const e of inbox) {
      if (!e || typeof e.id !== 'string' || seen.has(e.id)) continue;
      seen.add(e.id);
      if (this.eventsById.has(e.id) || this.engine.isSettled(e.id)) continue;
      fresh.push(e);
    }
    fresh.sort(compareEvents);
    for (const e of fresh) {
      this.processOne(e);
      stats.inboxProcessed++;
    }
    const recs = this.engine.retryPending();
    for (const r of recs) appendJsonl(this.p.audit, r);
    stats.retried = recs.length;
    this.persistState();
    this.regenerateAudit();
    atomicWriteFile(this.p.inbox, '');
    this.journal({ phase: 'recovered', ...stats });
    this.lastRecovery = stats;
    return stats;
  }

  // audit.log is a derived view: replay every logged event through a fresh
  // engine in log order. Deterministic, and repairs records lost by a crash
  // between the state commit and the audit append.
  regenerateAudit() {
    const shadow = createEngine({ windowMs: this.windowMs });
    const lines = [];
    for (const id of this.loggedIds) {
      lines.push(JSON.stringify(shadow.processEvent(this.eventsById.get(id))));
    }
    for (const rec of shadow.retryPending()) lines.push(JSON.stringify(rec));
    atomicWriteFile(this.p.audit, lines.length ? lines.join('\n') + '\n' : '');
  }

  processOne(e) {
    const id = e.id;
    this.journal({ tx: id, phase: 'begin' });
    this.fault('before-log', id);
    if (!this.eventsById.has(id)) {
      appendJsonl(this.p.events, e);
      this.eventsById.set(id, e);
      this.loggedIds.push(id);
    }
    this.fault('after-log', id);
    this.journal({ tx: id, phase: 'logged' });
    const rec = this.engine.processEvent(e);
    this.fault('before-index', id);
    this.writeIndex();
    this.fault('after-index', id);
    this.journal({ tx: id, phase: 'indexed' });
    this.fault('before-commit', id);
    this.writeLots();
    this.writePending();
    this.fault('after-commit', id);
    this.journal({ tx: id, phase: 'committed' });
    appendJsonl(this.p.audit, rec);
    return rec;
  }

  writeIndex() {
    atomicWriteFile(this.p.index, JSON.stringify({
      appliedIds: this.engine.appliedIds,
      rejected: this.engine.rejectedList,
      watermark: this.engine.watermark,
    }));
  }

  writeLots() {
    atomicWriteFile(this.p.lots, JSON.stringify(this.engine.lotsObject));
  }

  writePending() {
    atomicWriteFile(this.p.pending, JSON.stringify(this.engine.pendingList));
  }

  persistState() {
    this.writeIndex();
    this.writeLots();
    this.writePending();
  }

  ingest(events) {
    const report = emptyReport();
    report.received = events.length;
    const valid = [];
    for (const e of events) {
      const err = validateEvent(e);
      if (err) report.malformed.push({ event: e, error: err });
      else valid.push(e);
    }
    const seen = new Set();
    const fresh = [];
    for (const e of valid) {
      if (seen.has(e.id) || this.eventsById.has(e.id) || this.engine.isSettled(e.id)) {
        report.duplicates.push(e.id);
        continue;
      }
      seen.add(e.id);
      fresh.push(e);
    }
    // Durability first: everything received lands in the inbox before processing.
    for (const e of fresh) appendJsonl(this.p.inbox, e);
    fresh.sort(compareEvents);
    for (const e of fresh) collectRecord(report, this.processOne(e));
    for (const rec of this.engine.retryPending()) {
      appendJsonl(this.p.audit, rec);
      collectRecord(report, rec);
    }
    this.persistState();
    atomicWriteFile(this.p.inbox, '');
    return report;
  }

  loggedEvents() {
    return this.loggedIds.map((id) => this.eventsById.get(id));
  }

  auditTrail() {
    return readJsonl(this.p.audit);
  }
}
