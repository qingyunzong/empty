'use strict';
const { canonical, sha256 } = require('./util');

class BiobankError extends Error {
  constructor(code, detail) {
    super(code + (detail ? ': ' + detail : ''));
    this.name = 'BiobankError';
    this.code = code;
    this.detail = detail || null;
  }
}

const DEFAULTS = { aging: 1, freezeAfter: 10 };

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function normalizeConfig(raw) {
  if (!isPlainObject(raw) || raw.type !== 'config') {
    throw new BiobankError('illegal_event', 'first event must be a config object');
  }
  if (!Array.isArray(raw.racks) || raw.racks.length === 0) {
    throw new BiobankError('illegal_event', 'config.racks must be a non-empty array');
  }
  const seen = new Set();
  const racks = raw.racks.map((r) => {
    if (!isPlainObject(r)) throw new BiobankError('illegal_event', 'rack must be an object');
    if (typeof r.id !== 'string' || r.id === '') {
      throw new BiobankError('illegal_event', 'rack.id must be a non-empty string');
    }
    if (seen.has(r.id)) throw new BiobankError('illegal_event', 'duplicate rack id ' + r.id);
    seen.add(r.id);
    if (typeof r.zone !== 'string' || r.zone === '') {
      throw new BiobankError('illegal_event', 'rack.zone must be a non-empty string');
    }
    if (!Number.isInteger(r.capacity) || r.capacity <= 0) {
      throw new BiobankError('capacity_overflow', 'rack ' + r.id + ' capacity must be a positive integer');
    }
    return { id: r.id, zone: r.zone, capacity: r.capacity };
  });
  racks.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const quotas = {};
  if (raw.quotas !== undefined) {
    if (!isPlainObject(raw.quotas)) throw new BiobankError('illegal_event', 'config.quotas must be an object');
    for (const [project, q] of Object.entries(raw.quotas)) {
      if (!Number.isInteger(q) || q < 0) {
        throw new BiobankError('capacity_overflow', 'quota for project ' + project + ' must be a non-negative integer');
      }
      quotas[project] = q;
    }
  }
  const aging = raw.aging === undefined ? DEFAULTS.aging : raw.aging;
  if (!Number.isInteger(aging) || aging < 0) {
    throw new BiobankError('illegal_event', 'config.aging must be a non-negative integer');
  }
  const freezeAfter = raw.freezeAfter === undefined ? DEFAULTS.freezeAfter : raw.freezeAfter;
  if (!Number.isInteger(freezeAfter) || freezeAfter < 0) {
    throw new BiobankError('illegal_event', 'config.freezeAfter must be a non-negative integer');
  }
  return { racks, quotas, aging, freezeAfter };
}

function freshRacks(config) {
  return config.racks.map((r) => ({ id: r.id, zone: r.zone, capacity: r.capacity, slots: new Array(r.capacity).fill(null) }));
}

function createStore(configEvent) {
  const config = normalizeConfig(configEvent);
  return {
    config,
    configEvent,
    clock: 0,
    history: [],
    samples: new Map(),
    racks: freshRacks(config),
  };
}

function eventTime(ev) {
  return ev.type === 'arrive' ? ev.arrival : ev.time;
}

function quotaOf(sys, project) {
  const q = sys.config.quotas[project];
  return q === undefined ? Infinity : q;
}

function placedCountByProject(sys, project) {
  let n = 0;
  for (const s of sys.samples.values()) {
    if (s.status === 'placed' && s.project === project) n++;
  }
  return n;
}

function findSlot(sys, sample) {
  if (placedCountByProject(sys, sample.project) >= quotaOf(sys, sample.project)) return null;
  for (const rack of sys.racks) {
    if (rack.zone !== sample.zone) continue;
    const projectSlots = [];
    const free = [];
    for (let i = 0; i < rack.capacity; i++) {
      const occ = rack.slots[i];
      if (occ === null) {
        free.push(i);
      } else {
        const s = sys.samples.get(occ);
        if (s && s.project === sample.project) projectSlots.push(i);
      }
    }
    const candidates = projectSlots.length > 0
      ? free.filter((i) => projectSlots.some((j) => Math.abs(i - j) === 1))
      : free;
    if (candidates.length > 0) return { rack: rack.id, slot: Math.min(...candidates) };
  }
  return null;
}

function rejectionReason(sys, sample) {
  if (!sys.racks.some((r) => r.zone === sample.zone)) return 'no_zone';
  if (placedCountByProject(sys, sample.project) >= quotaOf(sys, sample.project)) return 'quota_exceeded';
  const hasFree = sys.racks.some((r) => r.zone === sample.zone && r.slots.some((s) => s === null));
  if (!hasFree) return 'no_capacity';
  return 'adjacency';
}

function findPreemption(sys, sample, now) {
  const candidates = [];
  for (const s of sys.samples.values()) {
    if (s.status !== 'placed') continue;
    if (s.preempts > 0) continue; // one-shot shield: a withdrawn sample can never be preempted again
    if (s.priority >= sample.priority) continue;
    if (now - s.placedAt >= sys.config.freezeAfter) continue; // frozen samples are untouchable
    candidates.push(s);
  }
  candidates.sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const victim of candidates) {
    const rack = sys.racks.find((r) => r.id === victim.rack);
    rack.slots[victim.slot] = null;
    victim.status = 'waiting';
    const slot = findSlot(sys, sample);
    victim.status = 'placed';
    rack.slots[victim.slot] = victim.id;
    if (slot) return victim;
  }
  return null;
}

function fairnessCompare(sys, a, b) {
  const ka = a.arrival - a.priority * sys.config.aging;
  const kb = b.arrival - b.priority * sys.config.aging;
  return ka - kb || a.arrival - b.arrival || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function sortedWaiting(sys) {
  return [...sys.samples.values()].filter((s) => s.status === 'waiting').sort((a, b) => fairnessCompare(sys, a, b));
}

function placementPass(sys, now, out) {
  for (const s of sys.samples.values()) {
    if (s.status === 'waiting' && now > s.deadline) {
      s.status = 'expired';
      out.expired.push(s.id);
    }
  }
  out.expired.sort();
  let moved = true;
  while (moved) {
    moved = false;
    for (const s of sortedWaiting(sys)) {
      if (s.status !== 'waiting') continue;
      let slot = findSlot(sys, s);
      if (!slot) {
        const victim = findPreemption(sys, s, now);
        if (victim) {
          const vrack = sys.racks.find((r) => r.id === victim.rack);
          vrack.slots[victim.slot] = null;
          victim.status = 'waiting';
          victim.rack = null;
          victim.slot = -1;
          victim.preempts++;
          out.preemptions.push({ by: s.id, withdrawn: victim.id });
          slot = findSlot(sys, s);
        }
      }
      if (slot) {
        const rack = sys.racks.find((r) => r.id === slot.rack);
        rack.slots[slot.slot] = s.id;
        s.status = 'placed';
        s.rack = slot.rack;
        s.slot = slot.slot;
        s.placedAt = now;
        out.placements.push({ id: s.id, rack: slot.rack, slot: slot.slot });
        moved = true;
      }
    }
  }
  for (const rack of sys.racks) {
    const occupied = rack.slots.filter((x) => x !== null).length;
    if (occupied > rack.capacity) {
      throw new BiobankError('capacity_overflow', 'rack ' + rack.id + ' overflow');
    }
  }
}

function validateEvent(sys, ev) {
  if (!isPlainObject(ev)) throw new BiobankError('illegal_event', 'event must be an object');
  if (typeof ev.type !== 'string') throw new BiobankError('illegal_event', 'event.type must be a string');
  switch (ev.type) {
    case 'arrive':
      if (typeof ev.id !== 'string' || ev.id === '') throw new BiobankError('illegal_event', 'arrive.id must be a non-empty string');
      if (sys.samples.has(ev.id)) throw new BiobankError('illegal_event', 'duplicate sample id ' + ev.id);
      if (typeof ev.project !== 'string' || ev.project === '') throw new BiobankError('illegal_event', 'arrive.project must be a non-empty string');
      if (!Number.isInteger(ev.priority)) throw new BiobankError('illegal_event', 'arrive.priority must be an integer');
      if (typeof ev.zone !== 'string' || ev.zone === '') throw new BiobankError('illegal_event', 'arrive.zone must be a non-empty string');
      if (!Number.isInteger(ev.arrival) || ev.arrival < 0) throw new BiobankError('illegal_event', 'arrive.arrival must be a non-negative integer');
      if (!Number.isInteger(ev.deadline)) throw new BiobankError('illegal_event', 'arrive.deadline must be an integer');
      break;
    case 'correct': {
      if (typeof ev.id !== 'string' || !sys.samples.has(ev.id)) throw new BiobankError('illegal_event', 'correct: unknown sample id');
      const s = sys.samples.get(ev.id);
      if (s.status === 'cancelled' || s.status === 'expired') {
        throw new BiobankError('illegal_event', 'cannot correct a ' + s.status + ' sample');
      }
      if (ev.priority === undefined && ev.deadline === undefined) {
        throw new BiobankError('illegal_event', 'correct requires priority and/or deadline');
      }
      if (ev.priority !== undefined && !Number.isInteger(ev.priority)) throw new BiobankError('illegal_event', 'correct.priority must be an integer');
      if (ev.deadline !== undefined && !Number.isInteger(ev.deadline)) throw new BiobankError('illegal_event', 'correct.deadline must be an integer');
      if (!Number.isInteger(ev.time)) throw new BiobankError('illegal_event', 'correct.time must be an integer');
      break;
    }
    case 'cancel':
      if (typeof ev.id !== 'string' || !sys.samples.has(ev.id)) throw new BiobankError('illegal_event', 'cancel: unknown sample id');
      if (sys.samples.get(ev.id).status !== 'waiting') {
        throw new BiobankError('illegal_event', 'only waiting samples can be cancelled');
      }
      if (!Number.isInteger(ev.time)) throw new BiobankError('illegal_event', 'cancel.time must be an integer');
      break;
    case 'undo':
      if (!Number.isInteger(ev.to) || ev.to < 0 || ev.to > sys.history.length) {
        throw new BiobankError('illegal_event', 'undo target out of range');
      }
      if (!Number.isInteger(ev.time)) throw new BiobankError('illegal_event', 'undo.time must be an integer');
      break;
    default:
      throw new BiobankError('illegal_event', 'unknown event type ' + ev.type);
  }
  const t = eventTime(ev);
  if (!Number.isInteger(t) || t < sys.clock) {
    throw new BiobankError('time_regression', 'event time ' + t + ' is before current clock ' + sys.clock);
  }
}

function applyToSys(sys, ev) {
  const t = eventTime(ev);
  sys.clock = t;
  if (ev.type === 'arrive') {
    sys.samples.set(ev.id, {
      id: ev.id, project: ev.project, priority: ev.priority, zone: ev.zone,
      arrival: ev.arrival, deadline: ev.deadline,
      status: 'waiting', rack: null, slot: -1, placedAt: -1, preempts: 0,
    });
  } else if (ev.type === 'correct') {
    const s = sys.samples.get(ev.id);
    if (ev.priority !== undefined) s.priority = ev.priority;
    if (ev.deadline !== undefined) s.deadline = ev.deadline;
  } else if (ev.type === 'cancel') {
    sys.samples.get(ev.id).status = 'cancelled';
  }
  const out = { placements: [], preemptions: [], expired: [] };
  placementPass(sys, t, out);
  return out;
}

function replay(config, events) {
  const sys = { config, clock: 0, samples: new Map(), racks: freshRacks(config) };
  for (const ev of events) applyToSys(sys, ev);
  return sys;
}

function snapshot(store) {
  return {
    clock: store.clock,
    events: store.history.length,
    samples: [...store.samples.values()]
      .map((s) => ({
        id: s.id, project: s.project, priority: s.priority, zone: s.zone,
        arrival: s.arrival, deadline: s.deadline, status: s.status,
        rack: s.rack, slot: s.slot, placedAt: s.placedAt, preempts: s.preempts,
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    racks: store.racks.map((r) => ({ id: r.id, slots: [...r.slots] })),
  };
}

function computeHash(store) {
  return sha256(canonical(snapshot(store)));
}

function buildResult(store, ev, out) {
  return {
    type: ev.type,
    placements: out.placements,
    preemptions: out.preemptions,
    expired: out.expired,
    waiting: sortedWaiting(store).map((s) => ({ id: s.id, reason: rejectionReason(store, s) })),
    hash: computeHash(store),
  };
}

function applyEvent(store, ev) {
  validateEvent(store, ev); // all validation happens before any mutation
  if (ev.type === 'undo') {
    store.history = store.history.slice(0, ev.to);
    const sys = replay(store.config, store.history);
    store.samples = sys.samples;
    store.racks = sys.racks;
    store.clock = sys.clock;
    return buildResult(store, ev, { placements: [], preemptions: [], expired: [] });
  }
  store.history.push(ev);
  const out = applyToSys(store, ev);
  return buildResult(store, ev, out);
}

module.exports = {
  BiobankError,
  normalizeConfig,
  createStore,
  applyEvent,
  computeHash,
  snapshot,
};
