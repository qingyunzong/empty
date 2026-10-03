// Transactional event store: append-only JSONL log + snapshot with replay
// recovery. Corrections undo the old value by key and record old/new in the
// log. Two simulated crash points: before_append (no effect) and
// after_append (log persisted, snapshot missing -> recovered by replay).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const COLLECTIONS = { workorder: 'workorders', bom: 'bom', inventory: 'inventory' };

export function emptyState() {
  return { workorders: {}, bom: {}, inventory: {} };
}

export function keyOf(entity, key) {
  if (entity === 'workorder') return String(key.id);
  if (entity === 'bom') return `${key.parent} ${key.component}`;
  if (entity === 'inventory') return String(key.component);
  throw new Error(`unknown entity: ${entity}`);
}

function validateValue(entity, value) {
  if (value === null || typeof value !== 'object') {
    throw new Error(`invalid value for ${entity}`);
  }
  if (entity === 'workorder') {
    if (typeof value.product !== 'string' || value.product === '') {
      throw new Error('workorder.product must be a non-empty string');
    }
    if (typeof value.qty !== 'number' || !Number.isFinite(value.qty) || value.qty <= 0) {
      throw new Error('workorder.qty must be a positive number');
    }
  } else if (entity === 'bom') {
    if (typeof value.usage !== 'number' || !Number.isFinite(value.usage) || value.usage <= 0) {
      throw new Error('bom.usage must be a positive number');
    }
  } else if (entity === 'inventory') {
    if (value.qty !== null &&
        (typeof value.qty !== 'number' || !Number.isFinite(value.qty) || value.qty < 0)) {
      throw new Error('inventory.qty must be null (unknown) or a non-negative number');
    }
  }
}

function validateKey(entity, key) {
  if (key === null || typeof key !== 'object') throw new Error(`invalid key for ${entity}`);
  if (entity === 'workorder' && (typeof key.id !== 'string' || key.id === '')) {
    throw new Error('workorder key requires non-empty id');
  }
  if (entity === 'bom' && (typeof key.parent !== 'string' || key.parent === '' ||
      typeof key.component !== 'string' || key.component === '')) {
    throw new Error('bom key requires non-empty parent and component');
  }
  if (entity === 'inventory' && (typeof key.component !== 'string' || key.component === '')) {
    throw new Error('inventory key requires non-empty component');
  }
}

// Apply one event to a mutable state; returns the log entry (with old/new).
function applyEvent(state, event, version) {
  const { op, entity, key } = event;
  if (!COLLECTIONS[entity]) throw new Error(`unknown entity: ${entity}`);
  validateKey(entity, key);
  const coll = state[COLLECTIONS[entity]];
  const k = keyOf(entity, key);
  const exists = Object.prototype.hasOwnProperty.call(coll, k);
  const oldValue = exists ? coll[k] : null;

  if (op === 'insert') {
    if (exists) throw new Error(`insert: key already exists for ${entity}: ${k}`);
    validateValue(entity, event.value);
    const row = entity === 'workorder'
      ? { id: key.id, ...event.value }
      : entity === 'bom'
        ? { parent: key.parent, component: key.component, ...event.value }
        : { component: key.component, ...event.value };
    coll[k] = row;
    return { v: version, op, entity, key, old: null, new: row };
  }
  if (op === 'correct') {
    if (!exists) throw new Error(`correct: unknown key for ${entity}: ${k}`);
    validateValue(entity, event.value);
    const row = { ...oldValue, ...event.value };
    coll[k] = row;
    return { v: version, op, entity, key, old: oldValue, new: row };
  }
  if (op === 'delete') {
    if (!exists) throw new Error(`delete: unknown key for ${entity}: ${k}`);
    delete coll[k];
    return { v: version, op, entity, key, old: oldValue, new: null };
  }
  throw new Error(`unknown op: ${op}`);
}

// Replay a log entry without validation (used during recovery).
function replayEntry(state, entry) {
  const coll = state[COLLECTIONS[entry.entity]];
  const k = keyOf(entry.entity, entry.key);
  if (entry.op === 'delete') delete coll[k];
  else coll[k] = entry.new;
}

export function logPath(dir) { return path.join(dir, 'events.log'); }
export function snapshotPath(dir) { return path.join(dir, 'snapshot.json'); }

export function loadLog(dir) {
  const p = logPath(dir);
  if (!fs.existsSync(p)) return [];
  const text = fs.readFileSync(p, 'utf8');
  return text.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
}

export function logHash(dir) {
  const p = logPath(dir);
  const bytes = fs.existsSync(p) ? fs.readFileSync(p) : Buffer.alloc(0);
  return 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex');
}

export function loadSnapshot(dir) {
  const p = snapshotPath(dir);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeSnapshot(dir, version, state) {
  const tmp = snapshotPath(dir) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ version, state, hash: logHash(dir) }, null, 2));
  fs.renameSync(tmp, snapshotPath(dir));
}

function appendLog(dir, entries) {
  const fd = fs.openSync(logPath(dir), 'a');
  try {
    for (const e of entries) fs.writeSync(fd, JSON.stringify(e) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function maxVersion(entries) {
  return entries.reduce((m, e) => Math.max(m, e.v), 0);
}

export function replayState(entries, uptoVersion = Infinity) {
  const state = emptyState();
  for (const e of entries) if (e.v <= uptoVersion) replayEntry(state, e);
  return state;
}

// Recover current state: trust snapshot up to its version, replay the rest.
// Rewrites the snapshot if it was missing or stale (crash recovery).
export function recover(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const entries = loadLog(dir);
  const logVersion = maxVersion(entries);
  const snap = loadSnapshot(dir);
  let state;
  let version;
  let recovered = false;
  if (snap && snap.version <= logVersion) {
    state = snap.state;
    version = snap.version;
  } else {
    state = emptyState();
    version = 0;
  }
  for (const e of entries) {
    if (e.v > version) {
      replayEntry(state, e);
      recovered = true;
    }
  }
  version = logVersion;
  if (recovered || !snap || snap.version !== logVersion) {
    writeSnapshot(dir, version, state);
  }
  return { state, version, entries, recovered };
}

// Apply a batch of events as one new version.
// fail: 'before_append' | 'after_append' | null (simulated crash points).
export function apply(dir, events, { fail = null } = {}) {
  if (!Array.isArray(events) || events.length === 0) {
    throw new Error('event batch must be a non-empty array');
  }
  fs.mkdirSync(dir, { recursive: true });
  const { version } = recover(dir);
  const nextVersion = version + 1;

  // Validate and stage against a working copy; nothing is persisted yet.
  const working = replayState(loadLog(dir));
  const entries = events.map((e) => applyEvent(working, e, nextVersion));

  if (fail === 'before_append') {
    throw new Error('simulated crash: before_append (no effect persisted)');
  }
  appendLog(dir, entries);
  if (fail === 'after_append') {
    throw new Error('simulated crash: after_append (log persisted, snapshot missing)');
  }
  writeSnapshot(dir, nextVersion, working);
  return { version: nextVersion, applied: entries.length, hash: logHash(dir) };
}

// Positive/negative deltas of net requirements between two states.
export function netDeltas(prevNet, currNet) {
  const components = {};
  const positive = {};
  const negative = {};
  const keys = new Set([...Object.keys(prevNet), ...Object.keys(currNet)]);
  for (const comp of [...keys].sort()) {
    const from = Object.prototype.hasOwnProperty.call(prevNet, comp) ? prevNet[comp] : 0;
    const to = Object.prototype.hasOwnProperty.call(currNet, comp) ? currNet[comp] : 0;
    const delta = from === null || to === null ? null : to - from;
    components[comp] = { from, to, delta };
    if (delta !== null && delta > 0) positive[comp] = delta;
    if (delta !== null && delta < 0) negative[comp] = delta;
  }
  return { components, positive, negative };
}
