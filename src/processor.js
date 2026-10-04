'use strict';

const crypto = require('node:crypto');

const EVENT_TYPES = new Set(['ASSIGN', 'PICK', 'DROP', 'FAIL', 'RETRY']);

class CycleError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CycleError';
    this.exitCode = 14;
  }
}

class RetryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RetryError';
    this.exitCode = 15;
  }
}

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.exitCode = 2;
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

function canonicalString(value) {
  return JSON.stringify(canonicalize(value));
}

function hashEvent(ev) {
  return crypto.createHash('sha256').update(canonicalString({
    type: ev.type, job: ev.job, leg: ev.leg, seq: ev.seq, causes: ev.causes, ts: ev.ts,
  })).digest('hex');
}

function validateEvent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ValidationError('event must be an object');
  }
  const { type, job, leg, seq, causes, ts } = raw;
  if (!EVENT_TYPES.has(type)) throw new ValidationError(`unknown event type: ${type}`);
  if (typeof job !== 'string' || job.length === 0) throw new ValidationError('job must be a non-empty string');
  if (typeof leg !== 'string' || leg.length === 0) throw new ValidationError('leg must be a non-empty string');
  if (!Number.isInteger(seq) || seq < 0) throw new ValidationError('seq must be a non-negative integer');
  if (!Array.isArray(causes) || causes.some((c) => typeof c !== 'string' || c.length === 0)) {
    throw new ValidationError('causes must be an array of non-empty strings');
  }
  if (!Number.isFinite(ts)) throw new ValidationError('ts must be a finite number');
  return { type, job, leg, seq, causes: [...causes], ts };
}

// Deterministic ordering of events inside one job: by seq, then ts, then hash.
function compareEvents(a, b) {
  if (a.seq !== b.seq) return a.seq - b.seq;
  if (a.ts !== b.ts) return a.ts - b.ts;
  return a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0;
}

class Processor {
  constructor({ timeoutMs = 30000 } = {}) {
    this.timeoutMs = timeoutMs;
    this.clock = 0; // virtual clock: max ts observed so far
    this.seen = new Set(); // event hashes for dedup
    this.events = []; // deduped events (with .hash)
    this.legs = new Map(); // `${job} ${leg}` -> { job, leg, pickTs, dropTs }
    this.staleLog = []; // append-only; entries gain revoked/revokedAt when refuted
    this.staleByLeg = new Map(); // legKey -> staleLog entry (open marks only)
    this.duplicates = 0;
  }

  ingest(raw) {
    const ev = validateEvent(raw);
    const hash = hashEvent(ev);
    if (this.seen.has(hash)) {
      this.duplicates++;
      return { duplicate: true };
    }
    this.seen.add(hash);
    const stored = { ...ev, hash };
    this.events.push(stored);
    if (ev.ts > this.clock) this.clock = ev.ts;

    const legKey = `${ev.job} ${ev.leg}`;
    if (ev.type === 'PICK') {
      if (!this.legs.has(legKey)) {
        this.legs.set(legKey, { job: ev.job, leg: ev.leg, pickTs: ev.ts, dropTs: null });
      } else {
        const rec = this.legs.get(legKey);
        if (rec.pickTs === null || ev.ts < rec.pickTs) rec.pickTs = ev.ts;
      }
    } else if (ev.type === 'DROP') {
      const rec = this.legs.get(legKey) || { job: ev.job, leg: ev.leg, pickTs: null, dropTs: null };
      rec.dropTs = rec.dropTs === null ? ev.ts : Math.min(rec.dropTs, ev.ts);
      this.legs.set(legKey, rec);
      // A DROP refutes an open stale mark on the same leg; the log keeps both facts.
      const open = this.staleByLeg.get(legKey);
      if (open) {
        open.revoked = true;
        open.revokedAt = this.clock;
        this.staleByLeg.delete(legKey);
      }
    }

    this.#evaluateStale();
    return { duplicate: false };
  }

  #evaluateStale() {
    for (const [legKey, rec] of this.legs) {
      if (rec.pickTs === null || rec.dropTs !== null) continue;
      if (this.clock - rec.pickTs > this.timeoutMs && !this.staleByLeg.has(legKey)) {
        const entry = {
          job: rec.job, leg: rec.leg, markedAt: this.clock, revoked: false, revokedAt: null,
        };
        this.staleLog.push(entry);
        this.staleByLeg.set(legKey, entry);
      }
    }
  }

  // Groups deduped events per job, sorted deterministically.
  #jobChains() {
    const byJob = new Map();
    for (const ev of this.events) {
      if (!byJob.has(ev.job)) byJob.set(ev.job, []);
      byJob.get(ev.job).push(ev);
    }
    for (const list of byJob.values()) list.sort(compareEvents);
    return byJob;
  }

  // Job-level directed graph from causes: edge job -> causeJob (job depends on causeJob).
  #causesGraph() {
    const graph = new Map(); // job -> Set of caused-by jobs
    for (const ev of this.events) {
      if (!graph.has(ev.job)) graph.set(ev.job, new Set());
      for (const c of ev.causes) {
        if (!graph.has(c)) graph.set(c, new Set());
        graph.get(ev.job).add(c);
      }
    }
    return graph;
  }

  #assertAcyclic(graph) {
    const state = new Map(); // 0=unvisited 1=in-stack 2=done
    const stack = [];
    const visit = (node) => {
      state.set(node, 1);
      stack.push(node);
      for (const next of graph.get(node) || []) {
        const s = state.get(next) || 0;
        if (s === 1) {
          const cycle = stack.slice(stack.indexOf(next)).concat(next);
          throw new CycleError(`causes cycle detected: ${cycle.join(' -> ')}`);
        }
        if (s === 0) visit(next);
      }
      stack.pop();
      state.set(node, 2);
    };
    for (const node of graph.keys()) {
      if ((state.get(node) || 0) === 0) visit(node);
    }
  }

  // Validates RETRY placement: a RETRY must immediately follow a FAIL in the
  // job's seq order and must create a brand-new leg (never reuse an old one).
  #assertRetryRules(byJob) {
    for (const [job, list] of byJob) {
      const seenLegs = new Set();
      let prev = null;
      for (const ev of list) {
        if (ev.type === 'RETRY') {
          if (!prev || prev.type !== 'FAIL') {
            throw new RetryError(
              `illegal RETRY in job ${job} seq ${ev.seq}: must immediately follow a FAIL`,
            );
          }
          if (seenLegs.has(ev.leg)) {
            throw new RetryError(
              `illegal RETRY in job ${job} seq ${ev.seq}: leg ${ev.leg} already exists (old legs are immutable)`,
            );
          }
        }
        seenLegs.add(ev.leg);
        prev = ev;
      }
    }
  }

  // A FAIL is compensated when the RETRY directly after it opens a new leg
  // that reaches DROP before any further FAIL in the same job.
  #uncompensatedFails(byJob) {
    const result = [];
    for (const [job, list] of byJob) {
      const droppedLegs = new Set();
      for (const ev of list) if (ev.type === 'DROP') droppedLegs.add(ev.leg);
      for (let i = 0; i < list.length; i++) {
        const ev = list[i];
        if (ev.type !== 'FAIL') continue;
        let compensated = false;
        const next = list[i + 1];
        if (next && next.type === 'RETRY') {
          let failedAgain = false;
          let dropped = false;
          for (let j = i + 2; j < list.length; j++) {
            const later = list[j];
            if (later.type === 'FAIL') { failedAgain = true; break; }
            if (later.type === 'DROP' && later.leg === next.leg) { dropped = true; break; }
          }
          compensated = dropped && !failedAgain && droppedLegs.has(next.leg);
        }
        if (!compensated) result.push({ job, seq: ev.seq, ts: ev.ts, causes: [...ev.causes] });
      }
    }
    result.sort((a, b) => (a.ts - b.ts) || (a.job < b.job ? -1 : a.job > b.job ? 1 : a.seq - b.seq));
    return result;
  }

  // Root causes = uncompensated FAILs that are not downstream (via causes,
  // transitively) of another uncompensated FAIL with ts <= theirs.
  #rootCauses(graph, uncompensated) {
    const ancestorsOf = (job) => {
      const seen = new Set();
      const stack = [...(graph.get(job) || [])];
      while (stack.length) {
        const n = stack.pop();
        if (seen.has(n)) continue;
        seen.add(n);
        for (const m of graph.get(n) || []) stack.push(m);
      }
      return seen;
    };
    const roots = [];
    for (const f of uncompensated) {
      const ancestors = ancestorsOf(f.job);
      const explained = uncompensated.some(
        (g) => g !== f && g.ts <= f.ts && ancestors.has(g.job),
      );
      if (!explained) roots.push({ job: f.job, seq: f.seq, ts: f.ts });
    }
    return roots;
  }

  // Builds the reconstructed directed chain plus derived analysis.
  finalize() {
    const byJob = this.#jobChains();
    const graph = this.#causesGraph();
    this.#assertAcyclic(graph);
    this.#assertRetryRules(byJob);
    const uncompensated = this.#uncompensatedFails(byJob);
    const rootCauses = this.#rootCauses(graph, uncompensated);

    const jobs = [...byJob.keys()].sort().map((job) => ({
      job,
      events: byJob.get(job).map((ev) => ({
        type: ev.type, leg: ev.leg, seq: ev.seq, causes: [...ev.causes], ts: ev.ts,
      })),
    }));
    const links = [];
    for (const job of byJob.keys()) {
      for (const cause of [...(graph.get(job) || [])].sort()) {
        links.push({ from: cause, to: job });
      }
    }
    links.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0));

    const chain = { jobs, links };
    const chainHash = crypto.createHash('sha256').update(canonicalString(chain)).digest('hex');
    return { chain, chainHash, uncompensatedFails: uncompensated, rootCauses };
  }

  getCertificate() {
    const { chainHash, rootCauses, uncompensatedFails } = this.finalize();
    const legs = [...this.legs.values()]
      .map((rec) => ({
        job: rec.job,
        leg: rec.leg,
        pickTs: rec.pickTs,
        dropTs: rec.dropTs,
        status: rec.dropTs !== null ? 'dropped' : rec.pickTs === null ? 'unpicked' : 'open',
      }))
      .sort((a, b) => (a.job < b.job ? -1 : a.job > b.job ? 1 : a.leg < b.leg ? -1 : 1));
    return {
      version: 1,
      clock: this.clock,
      timeoutMs: this.timeoutMs,
      chainHash,
      eventCount: this.events.length,
      duplicateCount: this.duplicates,
      legs,
      staleLog: this.staleLog.map((e) => ({ ...e })),
      uncompensatedFails,
      rootCauses,
    };
  }
}

module.exports = {
  Processor,
  CycleError,
  RetryError,
  ValidationError,
  canonicalString,
  hashEvent,
};
