// Durable store: append-only event log + dedup index + committed state.
//
// Write pipeline (per committed batch):
//   1. append events to events.log   (fsync)   [failpoints: before-log/after-log]
//   2. rewrite index.json            (atomic)  [failpoints: before-index/after-index]
//   3. apply to memory, write state.json (atomic) [failpoints: before-commit/after-commit]
//
// Recovery reconciles the three files so every logged event is applied
// exactly once: seq <= state.appliedSeq is already applied; anything newer
// is (re)applied regardless of whether the index saw it.
import fs from 'node:fs';
import path from 'node:path';
import { storage } from './errors.js';
import { applyEvent } from './statemachine.js';
import { resolveConflicts } from './conflict.js';
import { byTsId } from './event.js';

export const FAILPOINTS = ['before-log', 'after-log', 'before-index', 'after-index', 'before-commit', 'after-commit'];

export function createState() {
  return {
    version: 1,
    appliedSeq: 0,
    watermark: null, // highest event ts applied
    lots: {},
    devices: {},
    pending: {},
    conflicts: [],
    stats: { applied: 0, duplicates: 0, rejected: 0, late: 0 },
  };
}

export class Store {
  constructor(dir, { failpoints = [] } = {}) {
    this.dir = dir;
    this.logPath = path.join(dir, 'events.log');
    this.indexPath = path.join(dir, 'index.json');
    this.statePath = path.join(dir, 'state.json');
    this.failpoints = new Set(failpoints);
    fs.mkdirSync(dir, { recursive: true });
    this.state = this.#readJson(this.statePath) ?? createState();
    this.index = this.#readJson(this.indexPath) ?? { ids: {} };
  }

  static fromEnv(dir) {
    const fp = (process.env.EVENT_TRACE_FAILPOINT ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    return new Store(dir, { failpoints: fp });
  }

  #failpoint(stage) {
    if (this.failpoints.has(stage)) {
      throw storage(`injected failure at ${stage}`, { stage });
    }
  }

  #readJson(p) {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw storage(`corrupt file ${p}: ${err.message}`);
    }
  }

  #writeJsonAtomic(p, obj) {
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, p);
  }

  has(id) {
    return Object.hasOwn(this.index.ids, id);
  }

  persistState() {
    this.#writeJsonAtomic(this.statePath, this.state);
  }

  readLog() {
    let text;
    try {
      text = fs.readFileSync(this.logPath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    const out = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === '') continue;
      let rec;
      try {
        rec = JSON.parse(lines[i]);
      } catch {
        throw storage(`corrupt events.log at line ${i + 1}`);
      }
      out.push(rec);
    }
    return out;
  }

  // Persist a batch of new (already deduped, sorted) events and apply them.
  // `applyOne(event)` performs the in-memory transition and returns an
  // optional error record; errors are counted but do not abort the batch.
  commit(events, applyOne) {
    if (events.length === 0) return { applied: 0, errors: [] };
    const startSeq = this.readLog().length;

    this.#failpoint('before-log');
    const fd = fs.openSync(this.logPath, 'a');
    try {
      events.forEach((event, i) => {
        fs.writeSync(fd, JSON.stringify({ seq: startSeq + i + 1, event }) + '\n');
      });
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.#failpoint('after-log');

    this.#failpoint('before-index');
    events.forEach((event, i) => {
      this.index.ids[event.id] = startSeq + i + 1;
    });
    this.#writeJsonAtomic(this.indexPath, this.index);
    this.#failpoint('after-index');

    const errors = [];
    let applied = 0;
    for (const event of events) {
      const err = applyOne(event);
      if (err) errors.push(err);
      else applied++;
    }
    this.#failpoint('before-commit');
    this.state.appliedSeq = startSeq + events.length;
    this.#writeJsonAtomic(this.statePath, this.state);
    this.#failpoint('after-commit');
    return { applied, errors };
  }

  // Reconcile log/index/state after a crash. Returns a recovery report.
  recover(applyOne) {
    const log = this.readLog();
    const report = { scanned: log.length, applied: [], skipped: 0, duplicates: 0 };
    let dirty = false;
    for (const rec of log) {
      if (rec.seq <= this.state.appliedSeq) {
        report.skipped++;
        continue;
      }
      const prev = this.index.ids[rec.event.id];
      if (prev !== undefined && prev !== rec.seq) {
        report.duplicates++; // same id logged twice; first occurrence wins
        continue;
      }
      this.index.ids[rec.event.id] = rec.seq;
      applyOne(rec.event);
      report.applied.push(rec.seq);
      this.state.appliedSeq = rec.seq;
      dirty = true;
    }
    if (dirty) {
      this.#writeJsonAtomic(this.indexPath, this.index);
      this.#writeJsonAtomic(this.statePath, this.state);
    }
    return report;
  }

  // Full deterministic rebuild from the log (used by sync for convergence).
  rebuild(applyOne) {
    const log = this.readLog();
    const seen = new Map();
    const events = [];
    for (const rec of log) {
      if (seen.has(rec.event.id)) continue;
      seen.set(rec.event.id, true);
      events.push(rec.event);
    }
    events.sort(byTsId);
    this.state = createState();
    this.index = { ids: {} };
    let seq = 0;
    for (const e of events) {
      seq++;
      this.index.ids[e.id] = seq;
      applyOne(e);
    }
    this.state.appliedSeq = log.length; // every logged line is accounted for
    this.#writeJsonAtomic(this.indexPath, this.index);
    this.#writeJsonAtomic(this.statePath, this.state);
    return { events: events.length };
  }
}

// Default in-memory apply used by engine/recovery: sequential transition +
// stats, then causal conflict resolution is run by the caller at batch end.
// Quality events carrying causal deps are NOT sequentially applied: their
// ancestors may live on a peer store, so they are accounted here and their
// effect is computed by the causal layer (resolveConflicts) instead.
export function makeApplier(state, options = {}) {
  const errors = [];
  const window = options.window ?? null;
  const apply = (event) => {
    if (window !== null && state.watermark !== null && event.ts < state.watermark - window) {
      state.stats.late++;
    }
    if (event.kind.startsWith('quality.') && (event.payload?.deps?.length ?? 0) > 0) {
      state.stats.applied++;
      if (state.watermark === null || event.ts > state.watermark) state.watermark = event.ts;
      return null;
    }
    const r = applyEvent(state, event);
    if (!r.applied) {
      state.stats.rejected++;
      errors.push(r.error);
      return r.error;
    }
    state.stats.applied++;
    if (state.watermark === null || event.ts > state.watermark) state.watermark = event.ts;
    return null;
  };
  apply.errors = errors;
  return apply;
}

// Run after a batch/rebuild: fold causal conflicts into committed state.
export function finalizeConflicts(state, allEvents) {
  const { conflicts, errors } = resolveConflicts(state, allEvents);
  state.conflicts = conflicts;
  return { conflicts, errors };
}
