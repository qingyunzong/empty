'use strict';

const crypto = require('node:crypto');
const { solveSchedule } = require('./scheduler');

class EngineError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EngineError';
    this.exitCode = 3;
  }
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

const MUTATIONS = new Set(['plan', 'observe', 'correct', 'revoke']);

function requireString(v, what) {
  if (typeof v !== 'string' || v.length === 0) throw new EngineError(`${what} must be a non-empty string`);
}

function validateWindows(windows, ctx) {
  if (!Array.isArray(windows)) throw new EngineError(`${ctx}: windows must be an array`);
  const sorted = windows.slice().sort((a, b) => a[0] - b[0]);
  for (const w of windows) {
    if (!Array.isArray(w) || w.length !== 2 || !Number.isFinite(w[0]) || !Number.isFinite(w[1])) {
      throw new EngineError(`${ctx}: window must be a [start, end] pair of finite numbers`);
    }
    if (w[1] < w[0]) throw new EngineError(`${ctx}: negative duration window [${w[0]}, ${w[1]}]`);
  }
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i][0] < sorted[i - 1][1]) {
      throw new EngineError(`${ctx}: overlapping windows [${sorted[i - 1]}] and [${sorted[i]}]`);
    }
  }
}

function validateEvent(ev) {
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) throw new EngineError('event must be an object');
  if (typeof ev.type !== 'string') throw new EngineError('event missing type');
  switch (ev.type) {
    case 'plan': {
      requireString(ev.target, 'plan.target');
      if (typeof ev.duration !== 'number' || !Number.isFinite(ev.duration)) {
        throw new EngineError(`plan '${ev.target}': duration must be a finite number`);
      }
      if (ev.duration < 0) throw new EngineError(`plan '${ev.target}': negative duration`);
      if (ev.switch !== undefined && (typeof ev.switch !== 'number' || !Number.isFinite(ev.switch) || ev.switch < 0)) {
        throw new EngineError(`plan '${ev.target}': switch must be a non-negative number`);
      }
      if (ev.value !== undefined && (typeof ev.value !== 'number' || !Number.isFinite(ev.value))) {
        throw new EngineError(`plan '${ev.target}': value must be a finite number`);
      }
      if (ev.windows !== undefined) validateWindows(ev.windows, `plan '${ev.target}'`);
      if (ev.quota !== undefined && (typeof ev.quota !== 'number' || !Number.isFinite(ev.quota) || ev.quota < 0)) {
        throw new EngineError(`plan '${ev.target}': quota must be a non-negative number`);
      }
      if (ev.pi !== undefined) requireString(ev.pi, 'plan.pi');
      break;
    }
    case 'observe': {
      requireString(ev.id, 'observe.id');
      requireString(ev.target, 'observe.target');
      if (!Number.isFinite(ev.start) || !Number.isFinite(ev.end)) {
        throw new EngineError(`observe '${ev.id}': start/end must be finite numbers`);
      }
      if (ev.end < ev.start) throw new EngineError(`observe '${ev.id}': negative duration`);
      break;
    }
    case 'correct': {
      requireString(ev.target, 'correct.target');
      if (ev.windows !== undefined) validateWindows(ev.windows, `correct '${ev.target}'`);
      if (ev.cloud !== undefined && ev.cloud !== 'unknown' &&
          (typeof ev.cloud !== 'number' || !(ev.cloud >= 0 && ev.cloud <= 1))) {
        throw new EngineError(`correct '${ev.target}': cloud must be "unknown" or a number in [0, 1]`);
      }
      break;
    }
    case 'revoke':
      requireString(ev.id, 'revoke.id');
      break;
    case 'checkpoint':
      break;
    default:
      throw new EngineError(`unknown event type '${ev.type}'`);
  }
  if (ev.clock !== undefined && (typeof ev.clock !== 'number' || !Number.isFinite(ev.clock))) {
    throw new EngineError(`event clock must be a finite number`);
  }
  if (ev.node !== undefined && typeof ev.node !== 'string') {
    throw new EngineError(`event node must be a string`);
  }
}

// Concurrent-history merge: order by logical clock, conflicts broken by
// (clock, nodeID, targetID), then arrival order for full determinism.
function compareEntries(a, b) {
  const ca = a.event.clock !== undefined ? a.event.clock : a.seq;
  const cb = b.event.clock !== undefined ? b.event.clock : b.seq;
  if (ca !== cb) return ca - cb;
  const na = a.event.node || '';
  const nb = b.event.node || '';
  if (na !== nb) return na < nb ? -1 : 1;
  const ta = a.event.target || '';
  const tb = b.event.target || '';
  if (ta !== tb) return ta < tb ? -1 : 1;
  return a.seq - b.seq;
}

function freshState() {
  return {
    plans: new Map(),        // target -> {pi, duration, value, switch, windows}
    corrections: new Map(),  // target -> {windows?, cloud?}
    observes: new Map(),     // id -> {id, target, start, end, value?}
    revoked: [],             // revoked observation ids, in order
    quotas: {},              // pi -> quota
  };
}

function applyEvent(state, ev) {
  switch (ev.type) {
    case 'plan': {
      const pi = ev.pi !== undefined ? ev.pi : 'unknown';
      state.plans.set(ev.target, {
        pi,
        duration: ev.duration,
        value: ev.value !== undefined ? ev.value : 0,
        switch: ev.switch !== undefined ? ev.switch : 0,
        windows: ev.windows !== undefined ? ev.windows : [],
      });
      if (ev.quota !== undefined) state.quotas[pi] = ev.quota;
      break;
    }
    case 'observe':
      state.observes.set(ev.id, { id: ev.id, target: ev.target, start: ev.start, end: ev.end, value: ev.value });
      break;
    case 'revoke':
      if (!state.observes.has(ev.id)) throw new EngineError(`revoke: unknown observation '${ev.id}'`);
      state.observes.delete(ev.id);
      state.revoked.push(ev.id);
      break;
    case 'correct': {
      const prev = state.corrections.get(ev.target) || {};
      const next = { ...prev };
      if (ev.windows !== undefined) next.windows = ev.windows;
      if (ev.cloud !== undefined) next.cloud = ev.cloud;
      state.corrections.set(ev.target, next);
      break;
    }
    case 'checkpoint':
      break;
    default:
      throw new EngineError(`unknown event type '${ev.type}'`);
  }
}

function computeSchedule(state) {
  const targets = [];
  const pending = [];
  // A target with a confirmed (non-revoked) observation has its science
  // captured; it is fulfilled and never scheduled again.
  const fulfilled = new Set([...state.observes.values()].map(o => o.target));
  const planIds = [...state.plans.keys()].sort();
  for (const id of planIds) {
    if (fulfilled.has(id)) continue;
    const plan = state.plans.get(id);
    const corr = state.corrections.get(id);
    const windows = corr && corr.windows !== undefined ? corr.windows : plan.windows;
    const cloud = corr ? corr.cloud : undefined;
    if (cloud === 'unknown') {
      // Unknown cloud cover is pending, never unsatisfiable.
      pending.push({ target: id, reason: 'cloud-unknown' });
      continue;
    }
    targets.push({
      id, pi: plan.pi, duration: plan.duration, value: plan.value, switch: plan.switch,
      windows,
      closedByCorrection: !!(corr && corr.windows !== undefined && corr.windows.length === 0),
    });
  }
  const fixed = [...state.observes.values()].map(o => {
    const plan = state.plans.get(o.target);
    return {
      id: o.id, target: o.target,
      pi: plan ? plan.pi : 'unknown',
      start: o.start, end: o.end,
      value: o.value !== undefined ? o.value : (plan ? plan.value : 0),
    };
  });
  const result = solveSchedule(targets, fixed, state.quotas);
  const placed = new Map(result.placements.map(p => [p.target, p]));
  return { targets, pending, fixed, result, placed };
}

// Preemption happens only at observation boundaries: a previously scheduled
// (not yet confirmed) observation that disappears or moves after a mutation
// is recorded with interruption evidence.
function recordPreemptions(prevPlaced, sched, ev, out) {
  const fixedKeys = new Set(sched.fixed.map(f => `${f.target}|${f.start}|${f.end}`));
  for (const [target, pl] of prevPlaced) {
    const now = sched.placed.get(target);
    if (now && now.start === pl.start && now.end === pl.end) continue;
    if (fixedKeys.has(`${target}|${pl.start}|${pl.end}`)) continue; // confirmed, not preempted
    const replacedBy = [];
    for (const [t2, p2] of sched.placed) {
      if (t2 === target) continue;
      if (p2.start < pl.end && pl.start < p2.end) replacedBy.push(t2);
    }
    replacedBy.sort();
    out.push({
      target,
      plannedStart: pl.start,
      plannedEnd: pl.end,
      boundary: pl.start,
      cause: {
        type: ev.type,
        clock: ev.clock !== undefined ? ev.clock : null,
        node: ev.node !== undefined ? ev.node : null,
        target: ev.target !== undefined ? ev.target : null,
      },
      replacedBy,
    });
  }
}

function buildOutput(state, preemptions) {
  const sched = computeSchedule(state);
  const scheduled = sched.result.placements.slice()
    .sort((a, b) => a.start - b.start || (a.target < b.target ? -1 : 1));
  const placedIds = new Set(scheduled.map(p => p.target));
  const skipped = [];
  for (const t of sched.targets) {
    if (placedIds.has(t.id)) continue;
    let reason;
    if (t.windows.length === 0) {
      reason = t.closedByCorrection ? 'window-closed' : 'no-feasible-window';
    } else if (!t.windows.some(w => w[1] - w[0] >= t.duration)) {
      reason = 'no-feasible-window';
    } else {
      reason = 'not-selected';
    }
    skipped.push({ target: t.id, reason });
  }
  skipped.sort((a, b) => (a.target < b.target ? -1 : 1));
  const fixed = sched.fixed.slice().sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1));
  const exposure = {};
  for (const f of fixed) exposure[f.pi] = (exposure[f.pi] || 0) + (f.end - f.start);
  for (const p of scheduled) exposure[p.pi] = (exposure[p.pi] || 0) + (p.end - p.start);
  const deficits = {};
  for (const pi of Object.keys(state.quotas)) {
    deficits[pi] = Math.max(0, state.quotas[pi] - (exposure[pi] || 0));
  }
  const output = {
    schedule: scheduled,
    fixed,
    skipped,
    pending: sched.pending,
    preemptions: preemptions.map(p => ({ ...p, cause: { ...p.cause }, replacedBy: p.replacedBy.slice() })),
    revoked: state.revoked.slice(),
    exposure,
    quotas: { ...state.quotas },
    deficits,
    value: sched.result.value,
    fixedValue: fixed.reduce((s, f) => s + f.value, 0),
  };
  output.certificate = 'sha256:' + crypto.createHash('sha256').update(canonical(output)).digest('hex');
  return output;
}

class Engine {
  constructor() {
    this.entries = [];
  }

  ingest(event) {
    validateEvent(event);
    this.entries.push({ seq: this.entries.length, event });
  }

  // Pure fold over the merged event stream; does not mutate ingested entries.
  fold() {
    const merged = this.entries.slice().sort(compareEntries);
    const state = freshState();
    const preemptions = [];
    const checkpoints = [];
    let prevPlaced = new Map();
    for (let i = 0; i < merged.length; i++) {
      const ev = merged[i].event;
      applyEvent(state, ev);
      if (MUTATIONS.has(ev.type)) {
        const sched = computeSchedule(state);
        recordPreemptions(prevPlaced, sched, ev, preemptions);
        prevPlaced = sched.placed;
      }
      if (ev.type === 'checkpoint') {
        const output = buildOutput(state, preemptions);
        checkpoints.push({
          id: ev.id !== undefined ? String(ev.id) : `cp-${i}`,
          seq: i,
          events: merged.slice(0, i + 1).map(e => e.event),
          certificate: output.certificate,
          output,
        });
      }
    }
    return { output: buildOutput(state, preemptions), checkpoints };
  }
}

module.exports = { Engine, EngineError, canonical };
