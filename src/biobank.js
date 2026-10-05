'use strict';

const crypto = require('node:crypto');

const ERR = Object.freeze({
  INVALID_EVENT: 'INVALID_EVENT',
  TIME_REGRESSION: 'TIME_REGRESSION',
  CAPACITY_OVERFLOW: 'CAPACITY_OVERFLOW',
  INVALID_UNDO: 'INVALID_UNDO',
  INVALID_CONFIG: 'INVALID_CONFIG',
});

// Waiting sets larger than this use the deterministic greedy placer instead of
// the exact (optimal-count) search.
const EXACT_LIMIT = 12;

class BiobankError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BiobankError';
    this.code = code;
  }
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function isInt(v) {
  return Number.isInteger(v);
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

function newDict() {
  return Object.create(null);
}

function cloneSamples(samples) {
  const out = newDict();
  for (const [k, v] of Object.entries(samples)) out[k] = { ...v };
  return out;
}

function normalizeConfig(config) {
  const bad = (msg) => {
    throw new BiobankError(ERR.INVALID_CONFIG, msg);
  };
  if (!config || typeof config !== 'object' || Array.isArray(config)) bad('config must be an object');
  if (!Array.isArray(config.racks) || config.racks.length === 0) bad('config.racks must be a non-empty array');
  const seen = new Set();
  const racks = config.racks.map((r, i) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) bad(`racks[${i}] must be an object`);
    if (!isNonEmptyString(r.id)) bad(`racks[${i}].id must be a non-empty string`);
    if (seen.has(r.id)) bad(`duplicate rack id ${r.id}`);
    seen.add(r.id);
    if (!isNonEmptyString(r.zone)) bad(`racks[${i}].zone must be a non-empty string`);
    if (!isInt(r.capacity) || r.capacity < 1) bad(`racks[${i}].capacity must be an integer >= 1`);
    return { id: r.id, zone: r.zone, capacity: r.capacity };
  });
  const quotas = newDict();
  if (config.quotas !== undefined) {
    if (typeof config.quotas !== 'object' || config.quotas === null || Array.isArray(config.quotas)) {
      bad('config.quotas must be an object mapping project -> non-negative integer');
    }
    for (const [k, v] of Object.entries(config.quotas)) {
      if (!isInt(v) || v < 0) bad(`quota for project ${k} must be an integer >= 0`);
      quotas[k] = v;
    }
  }
  const intOr = (v, dflt, min, name) => {
    if (v === undefined) return dflt;
    if (!isInt(v) || v < min) bad(`${name} must be an integer >= ${min}`);
    return v;
  };
  return {
    racks,
    quotas,
    defaultQuota: intOr(config.defaultQuota, Infinity, 0, 'defaultQuota'),
    agingWeight: intOr(config.agingWeight, 10, 1, 'agingWeight'),
    freezeDelay: intOr(config.freezeDelay, 10, 0, 'freezeDelay'),
    maxActiveSamples: intOr(config.maxActiveSamples, Infinity, 1, 'maxActiveSamples'),
  };
}

function createBank(config) {
  const cfg = normalizeConfig(config);
  const racks = cfg.racks;

  let state = { now: 0, samples: newDict() };
  let activeEvents = [];
  let stepCount = 0;

  const quotaFor = (project) => (Object.hasOwn(cfg.quotas, project) ? cfg.quotas[project] : cfg.defaultQuota);
  const isFrozen = (s, now) => now - s.placedAt >= cfg.freezeDelay;
  const scoreOf = (s, now) => s.priority * cfg.agingWeight + (now - s.arriveTime);

  function rankWaiting() {
    const now = state.now;
    return Object.values(state.samples)
      .filter((s) => s.status === 'waiting')
      .map((s) => ({ s, score: scoreOf(s, now) }))
      .sort((a, b) => b.score - a.score || (a.s.id < b.s.id ? -1 : a.s.id > b.s.id ? 1 : 0))
      .map((x) => x.s);
  }

  function buildLayout() {
    const slots = racks.map((r) => new Array(r.capacity).fill(null));
    for (const s of Object.values(state.samples)) {
      if (s.status === 'placed') slots[s.rack][s.slot] = s.id;
    }
    return slots;
  }

  function placedProjectCounts() {
    const projCount = newDict();
    for (const s of Object.values(state.samples)) {
      if (s.status === 'placed') projCount[s.project] = (projCount[s.project] || 0) + 1;
    }
    return projCount;
  }

  function feasiblePositions(sample, slots, projCount) {
    if ((projCount[sample.project] || 0) >= quotaFor(sample.project)) return [];
    const out = [];
    for (let i = 0; i < racks.length; i++) {
      if (racks[i].zone !== sample.zone) continue;
      const ps = [];
      for (let sl = 0; sl < racks[i].capacity; sl++) {
        const id = slots[i][sl];
        if (id !== null && state.samples[id].project === sample.project) ps.push(sl);
      }
      for (let sl = 0; sl < racks[i].capacity; sl++) {
        if (slots[i][sl] !== null) continue;
        const min = ps[0];
        const max = ps[ps.length - 1];
        if (ps.length === 0 || sl === min - 1 || sl === max + 1 || (sl > min && sl < max)) {
          out.push([i, sl]);
        }
      }
    }
    return out;
  }

  function runPlacement() {
    const waiting = rankWaiting();
    if (waiting.length === 0) return [];
    const slots = buildLayout();
    const projCount = placedProjectCounts();
    const chosen = [];
    if (waiting.length <= EXACT_LIMIT) {
      // Exact search: maximize the number of newly placed samples. Ties keep
      // the first solution found, which (place-before-skip, racks and slots in
      // ascending order) prefers higher-ranked samples and lower positions.
      let best = null;
      const current = [];
      const dfs = (idx) => {
        if (best && current.length + (waiting.length - idx) <= best.length) return;
        if (idx === waiting.length) {
          best = current.slice();
          return;
        }
        const sample = waiting[idx];
        for (const [i, sl] of feasiblePositions(sample, slots, projCount)) {
          slots[i][sl] = sample.id;
          projCount[sample.project] = (projCount[sample.project] || 0) + 1;
          current.push([sample, i, sl]);
          dfs(idx + 1);
          current.pop();
          slots[i][sl] = null;
          projCount[sample.project] -= 1;
        }
        dfs(idx + 1);
      };
      dfs(0);
      for (const [sample, i, sl] of best || []) chosen.push([sample, i, sl]);
    } else {
      for (const sample of waiting) {
        const pos = feasiblePositions(sample, slots, projCount);
        if (pos.length > 0) {
          const [i, sl] = pos[0];
          slots[i][sl] = sample.id;
          projCount[sample.project] = (projCount[sample.project] || 0) + 1;
          chosen.push([sample, i, sl]);
        }
      }
    }
    const placed = [];
    for (const [sample, i, sl] of chosen) {
      sample.status = 'placed';
      sample.rack = i;
      sample.slot = sl;
      sample.placedAt = state.now;
      placed.push({ sample: sample.id, rack: racks[i].id, slot: sl });
    }
    return placed;
  }

  function canPlaceAfterRemoval(sample, victim) {
    const saved = { status: victim.status, rack: victim.rack, slot: victim.slot, placedAt: victim.placedAt };
    victim.status = 'waiting';
    victim.rack = null;
    victim.slot = null;
    victim.placedAt = null;
    const ok = feasiblePositions(sample, buildLayout(), placedProjectCounts()).length > 0;
    Object.assign(victim, saved);
    return ok;
  }

  function runPreemption(result) {
    const preemptedThisPass = new Set();
    const maxIterations = Object.keys(state.samples).length + 2;
    for (let guard = 0; guard < maxIterations; guard++) {
      const waiting = rankWaiting();
      let victim = null;
      let preemptor = null;
      for (const s of waiting) {
        const candidates = [];
        for (const v of Object.values(state.samples)) {
          if (v.status !== 'placed') continue;
          if (preemptedThisPass.has(v.id)) continue;
          if (isFrozen(v, state.now)) continue;
          if (scoreOf(v, state.now) >= scoreOf(s, state.now)) continue;
          if (racks[v.rack].zone !== s.zone) continue;
          if (canPlaceAfterRemoval(s, v)) candidates.push(v);
        }
        if (candidates.length > 0) {
          candidates.sort((a, b) => scoreOf(a, state.now) - scoreOf(b, state.now) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
          victim = candidates[0];
          preemptor = s;
          break;
        }
      }
      if (!victim) return;
      preemptedThisPass.add(victim.id);
      result.preempted.push({ sample: victim.id, rack: racks[victim.rack].id, slot: victim.slot, by: preemptor.id });
      victim.status = 'waiting';
      victim.rack = null;
      victim.slot = null;
      victim.placedAt = null;
      result.placed.push(...runPlacement());
    }
  }

  function schedule(result) {
    for (const s of Object.values(state.samples)) {
      if (s.status === 'waiting' && s.deadline < state.now) {
        s.status = 'expired';
        result.expired.push({ sample: s.id, reason: 'deadline_exceeded' });
      }
    }
    result.expired.sort((a, b) => (a.sample < b.sample ? -1 : a.sample > b.sample ? 1 : 0));
    result.placed.push(...runPlacement());
    runPreemption(result);
  }

  const KNOWN_TYPES = new Set(['arrive', 'correct', 'cancel', 'undo']);

  function validateEnvelope(ev) {
    if (!ev || typeof ev !== 'object' || Array.isArray(ev)) {
      throw new BiobankError(ERR.INVALID_EVENT, 'event must be an object');
    }
    if (!KNOWN_TYPES.has(ev.type)) {
      throw new BiobankError(ERR.INVALID_EVENT, `unknown event type: ${ev.type}`);
    }
    if (!isInt(ev.time) || ev.time < 0) {
      throw new BiobankError(ERR.INVALID_EVENT, 'event.time must be a non-negative integer');
    }
  }

  function applyMutation(ev, result) {
    switch (ev.type) {
      case 'arrive': {
        const sm = ev.sample;
        if (!sm || typeof sm !== 'object' || Array.isArray(sm)) {
          throw new BiobankError(ERR.INVALID_EVENT, 'arrive requires a sample object');
        }
        if (!isNonEmptyString(sm.id)) throw new BiobankError(ERR.INVALID_EVENT, 'sample.id must be a non-empty string');
        if (!isNonEmptyString(sm.project)) throw new BiobankError(ERR.INVALID_EVENT, 'sample.project must be a non-empty string');
        if (!isInt(sm.priority)) throw new BiobankError(ERR.INVALID_EVENT, 'sample.priority must be an integer');
        if (!isInt(sm.deadline)) throw new BiobankError(ERR.INVALID_EVENT, 'sample.deadline must be an integer');
        if (!isNonEmptyString(sm.zone)) throw new BiobankError(ERR.INVALID_EVENT, 'sample.zone must be a non-empty string');
        if (state.samples[sm.id]) throw new BiobankError(ERR.INVALID_EVENT, `duplicate sample id ${sm.id}`);
        const active = Object.values(state.samples).filter((s) => s.status === 'waiting' || s.status === 'placed').length;
        if (active >= cfg.maxActiveSamples) {
          throw new BiobankError(ERR.CAPACITY_OVERFLOW, `active sample capacity ${cfg.maxActiveSamples} exceeded`);
        }
        if (!racks.some((r) => r.zone === sm.zone)) {
          result.rejected.push({ sample: sm.id, reason: 'no_rack_for_zone' });
          return;
        }
        if (sm.deadline < state.now) {
          result.rejected.push({ sample: sm.id, reason: 'deadline_exceeded' });
          return;
        }
        state.samples[sm.id] = {
          id: sm.id,
          project: sm.project,
          priority: sm.priority,
          deadline: sm.deadline,
          zone: sm.zone,
          arriveTime: state.now,
          status: 'waiting',
          rack: null,
          slot: null,
          placedAt: null,
        };
        return;
      }
      case 'correct': {
        if (!isNonEmptyString(ev.sampleId)) throw new BiobankError(ERR.INVALID_EVENT, 'correct requires sampleId');
        const s = state.samples[ev.sampleId];
        if (!s || (s.status !== 'waiting' && s.status !== 'placed')) {
          throw new BiobankError(ERR.INVALID_EVENT, `cannot correct unknown or inactive sample ${ev.sampleId}`);
        }
        const hasP = ev.priority !== undefined;
        const hasD = ev.deadline !== undefined;
        if (!hasP && !hasD) throw new BiobankError(ERR.INVALID_EVENT, 'correct requires priority and/or deadline');
        if (hasP && !isInt(ev.priority)) throw new BiobankError(ERR.INVALID_EVENT, 'correct priority must be an integer');
        if (hasD && !isInt(ev.deadline)) throw new BiobankError(ERR.INVALID_EVENT, 'correct deadline must be an integer');
        if (hasP) s.priority = ev.priority;
        if (hasD) s.deadline = ev.deadline;
        return;
      }
      case 'cancel': {
        if (!isNonEmptyString(ev.sampleId)) throw new BiobankError(ERR.INVALID_EVENT, 'cancel requires sampleId');
        const s = state.samples[ev.sampleId];
        if (!s || (s.status !== 'waiting' && s.status !== 'placed')) {
          throw new BiobankError(ERR.INVALID_EVENT, `cannot cancel unknown or inactive sample ${ev.sampleId}`);
        }
        if (s.status === 'placed' && isFrozen(s, state.now)) {
          throw new BiobankError(ERR.INVALID_EVENT, `cannot cancel frozen sample ${s.id}`);
        }
        s.status = 'cancelled';
        s.rack = null;
        s.slot = null;
        s.placedAt = null;
        result.cancelled.push(s.id);
        return;
      }
      default:
        throw new BiobankError(ERR.INVALID_EVENT, `event type ${ev.type} is not allowed in a mutation step`);
    }
  }

  function rebuild() {
    const events = activeEvents;
    state = { now: 0, samples: newDict() };
    activeEvents = [];
    let i = 0;
    while (i < events.length) {
      const t = events[i].time;
      const group = [];
      while (i < events.length && events[i].time === t) group.push(events[i++]);
      state.now = t;
      const result = { placed: [], preempted: [], expired: [], rejected: [], cancelled: [] };
      for (const ev of group) applyMutation(ev, result);
      schedule(result);
      activeEvents.push(...group);
    }
  }

  function certState() {
    const placed = [];
    const waiting = [];
    const frozenList = [];
    for (const s of Object.values(state.samples)) {
      if (s.status === 'placed') {
        const f = isFrozen(s, state.now);
        placed.push({ id: s.id, rack: racks[s.rack].id, slot: s.slot, frozen: f });
        if (f) frozenList.push(s.id);
      } else if (s.status === 'waiting') {
        waiting.push(s.id);
      }
    }
    const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    placed.sort((a, b) => byId(a.id, b.id));
    waiting.sort(byId);
    frozenList.sort(byId);
    return { now: state.now, eventPoint: activeEvents.length, placed, waiting, frozen: frozenList };
  }

  function snapshotHash() {
    return sha256(canonical(certState()));
  }

  function doUndo(ev) {
    const to = ev.to;
    if (!isInt(to) || to < 0 || to > activeEvents.length) {
      throw new BiobankError(ERR.INVALID_UNDO, `cannot undo to event point ${to}; current event point is ${activeEvents.length}`);
    }
    activeEvents = activeEvents.slice(0, to);
    rebuild();
    stepCount += 1;
    return {
      step: stepCount,
      time: ev.time,
      events: [ev],
      undoTo: to,
      placed: [],
      preempted: [],
      expired: [],
      rejected: [],
      cancelled: [],
      waiting: rankWaiting().map((s) => s.id),
      eventPoint: activeEvents.length,
      hash: snapshotHash(),
    };
  }

  function applyStep(events) {
    if (!Array.isArray(events) || events.length === 0) {
      throw new BiobankError(ERR.INVALID_EVENT, 'a step requires a non-empty array of events');
    }
    for (const ev of events) validateEnvelope(ev);
    const isUndo = events[0].type === 'undo';
    for (const ev of events) {
      if ((ev.type === 'undo') !== isUndo || (isUndo && events.length !== 1)) {
        throw new BiobankError(ERR.INVALID_EVENT, 'an undo event must be the only event in its step');
      }
      if (!isUndo && ev.time !== events[0].time) {
        throw new BiobankError(ERR.INVALID_EVENT, 'all events in a step must share the same time');
      }
    }
    const time = events[0].time;
    if (time < state.now) {
      throw new BiobankError(ERR.TIME_REGRESSION, `event time ${time} is before current time ${state.now}`);
    }
    const snapshot = { state: { now: state.now, samples: cloneSamples(state.samples) }, activeEvents: activeEvents.slice(), stepCount };
    try {
      if (isUndo) return doUndo(events[0]);
      state.now = time;
      const result = { step: stepCount + 1, time, events, placed: [], preempted: [], expired: [], rejected: [], cancelled: [] };
      for (const ev of events) applyMutation(ev, result);
      schedule(result);
      activeEvents.push(...events);
      stepCount += 1;
      result.waiting = rankWaiting().map((s) => s.id);
      result.eventPoint = activeEvents.length;
      result.hash = snapshotHash();
      return result;
    } catch (err) {
      state = snapshot.state;
      activeEvents = snapshot.activeEvents;
      stepCount = snapshot.stepCount;
      throw err;
    }
  }

  function getState() {
    return { ...certState(), samples: cloneSamples(state.samples), stepCount };
  }

  return {
    applyStep,
    getState,
    certState,
    hash: snapshotHash,
    get eventPoint() {
      return activeEvents.length;
    },
    get stepCount() {
      return stepCount;
    },
    config: cfg,
  };
}

module.exports = { createBank, BiobankError, ERR, canonical, sha256, EXACT_LIMIT };
