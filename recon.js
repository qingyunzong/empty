'use strict';

// Reconciliation recompute engine.
//
// Model:
// - confirmed.jsonl provides base snapshots: {level, target, amount, locked?, watermark?, version?, parent?}
//   level: day|mch|txn; target: "2024-01-01" | "2024-01-01/M001" | "2024-01-01/M001/T001".
// - deltas.jsonl provides corrections: {scope: day|mch|txn, target, delta, eventTime, seq}.
// - Every correction/rollback appends a NEW version; locked snapshots stay read-only.
// - Watermark: a delta enters the current recompute only when eventTime <= watermark
//   (targets without a watermark admit all deltas); later deltas stay pending.
// - Concurrent deltas on the same target are ordered by (eventTime, seq); equal keys
//   are ALL applied and marked TIE (never randomly picked).

class CycleError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CycleError';
    this.code = 'CYCLE';
  }
}

const LEVELS = ['day', 'mch', 'txn'];

function keyOf(level, target) {
  return level + ':' + target;
}

function isValidLevel(level) {
  return LEVELS.includes(level);
}

// True when (level, target) sits strictly below (ancestorLevel, ancestorTarget)
// in the day -> mch -> txn hierarchy (target paths are '/'-joined).
function isDescendantOf(ancestorLevel, ancestorTarget, level, target) {
  if (ancestorLevel === 'day') {
    return (level === 'mch' || level === 'txn') && target.startsWith(ancestorTarget + '/');
  }
  if (ancestorLevel === 'mch') {
    return level === 'txn' && target.startsWith(ancestorTarget + '/');
  }
  return false;
}

function createState() {
  return { targets: new Map(), out: [] };
}

function getEntry(state, level, target) {
  return state.targets.get(keyOf(level, target));
}

function ensureEntry(state, level, target) {
  const key = keyOf(level, target);
  let entry = state.targets.get(key);
  if (!entry) {
    entry = { level, target, versions: [], locked: false, watermark: null };
    state.targets.set(key, entry);
  }
  return entry;
}

// Order base records of one target into a parent chain, detecting cycles.
function resolveChain(recs, key) {
  const nodes = recs.map((r, i) => ({
    version: r.version != null ? r.version : i + 1,
    parent: r.parent !== undefined ? r.parent : (i === 0 ? null : (r.version != null ? r.version - 1 : i)),
    amount: r.amount,
    status: r.status || 'confirmed',
  }));
  const ordered = [];
  const visited = new Set();
  let current = nodes.find((n) => n.parent == null) || null;
  while (current) {
    if (visited.has(current.version)) {
      throw new CycleError(`cyclic parent chain for ${key}`);
    }
    visited.add(current.version);
    ordered.push(current);
    current = nodes.find((n) => n.parent === current.version) || null;
  }
  if (ordered.length !== nodes.length) {
    throw new CycleError(`cyclic parent chain for ${key}`);
  }
  return ordered;
}

function loadBase(state, records) {
  const groups = new Map();
  for (const rec of records) {
    if (!isValidLevel(rec.level)) throw new Error(`invalid level: ${rec.level}`);
    const key = keyOf(rec.level, rec.target);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(rec);
  }
  for (const [key, recs] of groups) {
    const entry = ensureEntry(state, recs[0].level, recs[0].target);
    entry.locked = recs.some((r) => r.locked === true);
    const watermarks = recs.map((r) => r.watermark).filter(Boolean).sort();
    if (watermarks.length) entry.watermark = watermarks[watermarks.length - 1];
    for (const node of resolveChain(recs, key)) {
      entry.versions.push(node);
      state.out.push({ level: entry.level, target: entry.target, ...node });
    }
  }
  return state;
}

function applyDeltas(state, deltas) {
  const sorted = deltas
    .map((d, i) => ({ ...d, _i: i }))
    .sort((a, b) =>
      (a.eventTime < b.eventTime ? -1 : a.eventTime > b.eventTime ? 1 : 0) ||
      ((a.seq || 0) - (b.seq || 0)) ||
      (a._i - b._i));

  // Tie = same target AND same (eventTime, seq); every member is kept and marked TIE.
  const tieCount = new Map();
  for (const d of sorted) {
    const k = `${keyOf(d.scope, d.target)}|${d.eventTime}|${d.seq || 0}`;
    tieCount.set(k, (tieCount.get(k) || 0) + 1);
  }

  for (const d of sorted) {
    if (!isValidLevel(d.scope)) throw new Error(`invalid scope: ${d.scope}`);
    const entry = getEntry(state, d.scope, d.target);
    if (!entry || entry.versions.length === 0) {
      state.out.push({ level: d.scope, target: d.target, version: null, parent: null, amount: null, status: 'NO_VERSION' });
      continue;
    }
    if (entry.locked) {
      // Locked snapshots are read-only: the delta waits in pending.
      state.out.push({ level: d.scope, target: d.target, version: null, parent: null, amount: null, status: 'pending' });
      continue;
    }
    if (entry.watermark && d.eventTime > entry.watermark) {
      state.out.push({ level: d.scope, target: d.target, version: null, parent: null, amount: null, status: 'pending' });
      continue;
    }
    const tieKey = `${keyOf(d.scope, d.target)}|${d.eventTime}|${d.seq || 0}`;
    const latest = entry.versions[entry.versions.length - 1];
    const version = {
      version: latest.version + 1,
      parent: latest.version,
      amount: latest.amount + (d.delta || 0),
      status: tieCount.get(tieKey) > 1 ? 'TIE' : 'applied',
    };
    entry.versions.push(version);
    state.out.push({ level: entry.level, target: entry.target, ...version });
  }
  return state;
}

function appendRollback(state, entry, toVersion) {
  const src = entry.versions.find((v) => v.version === toVersion);
  if (!src) return false;
  const latest = entry.versions[entry.versions.length - 1];
  const version = {
    version: latest.version + 1,
    parent: latest.version,
    amount: src.amount,
    status: 'rolledback',
  };
  entry.versions.push(version);
  state.out.push({ level: entry.level, target: entry.target, ...version });
  return true;
}

// Roll back `level:target` to `version` (default: base v1). Rolling back a day
// cascades to its mch/txn descendants (to their base v1); rolling back a txn
// touches only that txn, never its siblings.
function rollback(state, spec) {
  const { level, target } = spec;
  const toVersion = spec.version != null ? spec.version : 1;
  const entry = getEntry(state, level, target);
  if (!entry || entry.versions.length === 0 || !appendRollback(state, entry, toVersion)) {
    state.out.push({ level, target, version: toVersion, parent: null, amount: null, status: 'NO_VERSION' });
    return false;
  }
  for (const e of state.targets.values()) {
    if (e === entry || e.locked) continue;
    if (isDescendantOf(level, target, e.level, e.target)) {
      appendRollback(state, e, 1);
    }
  }
  return true;
}

function serialize(state) {
  return state.out.map((r) => JSON.stringify(r)).join('\n') + (state.out.length ? '\n' : '');
}

module.exports = {
  CycleError,
  LEVELS,
  createState,
  loadBase,
  applyDeltas,
  rollback,
  serialize,
  isDescendantOf,
};
