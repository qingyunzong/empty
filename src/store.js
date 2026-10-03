import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { grossRequirements, referenceGross, netRequirements, toSortedObject } from './mrp.js';

export class StoreError extends Error {}

const LOG_FILE = 'log.jsonl';
const SNAPSHOT_FILE = 'snapshot.json';

function fail(message) {
  throw new StoreError(message);
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${field} must be a non-empty string`);
  }
}

function requireNumber(value, field, { min = null, minExclusive = null } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`${field} must be a finite number`);
  }
  if (min !== null && value < min) fail(`${field} must be >= ${min}`);
  if (minExclusive !== null && value <= minExclusive) fail(`${field} must be > ${minExclusive}`);
}

const TABLES = {
  work_order: {
    keyOf: (r) => [r.id],
    validate(r) {
      requireString(r.id, 'work_order.id');
      requireString(r.product, 'work_order.product');
      requireNumber(r.qty, 'work_order.qty', { minExclusive: 0 });
    },
  },
  bom: {
    keyOf: (r) => [r.parent, r.component],
    validate(r) {
      requireString(r.parent, 'bom.parent');
      requireString(r.component, 'bom.component');
      requireNumber(r.usage, 'bom.usage', { minExclusive: 0 });
    },
  },
  inventory: {
    keyOf: (r) => [r.component],
    validate(r) {
      requireString(r.component, 'inventory.component');
      if (r.qty !== null) requireNumber(r.qty, 'inventory.qty', { min: 0 });
    },
  },
};

export function emptyState() {
  return { work_order: {}, bom: {}, inventory: {} };
}

function keyString(table, keyFields) {
  return JSON.stringify(keyFields);
}

function normalizeEvent(event) {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    fail('event must be an object');
  }
  const { op, table } = event;
  if (!['insert', 'correct', 'delete'].includes(op)) fail(`unsupported op: ${op}`);
  const spec = TABLES[table];
  if (!spec) fail(`unknown table: ${table}`);
  if (op === 'delete') {
    const source = event.key ?? event.record;
    if (source === null || typeof source !== 'object') fail('delete requires key or record');
    const keyFields = spec.keyOf(source);
    if (keyFields.some((f) => f === undefined)) fail(`delete on ${table} is missing key fields`);
    return { op, table, keyFields, record: null };
  }
  const record = event.record;
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    fail(`${op} requires a record object`);
  }
  spec.validate(record);
  const keyFields = spec.keyOf(record);
  if (keyFields.some((f) => f === undefined)) fail(`${op} on ${table} is missing key fields`);
  return { op, table, keyFields, record };
}

// Applies a normalized event to state; returns the previous record (undo info)
// or null for a fresh insert. Throws StoreError on key violations.
function applyToState(state, event) {
  const key = keyString(event.table, event.keyFields);
  const bucket = state[event.table];
  const prev = Object.hasOwn(bucket, key) ? bucket[key] : undefined;
  if (event.op === 'insert') {
    if (prev !== undefined) fail(`insert duplicate key on ${event.table}: ${key}`);
    bucket[key] = event.record;
    return null;
  }
  if (event.op === 'correct') {
    if (prev === undefined) fail(`correct unknown key on ${event.table}: ${key}`);
    bucket[key] = event.record;
    return prev;
  }
  if (prev === undefined) fail(`delete unknown key on ${event.table}: ${key}`);
  delete bucket[key];
  return prev;
}

function logPath(dir) {
  return path.join(dir, LOG_FILE);
}

function snapshotPath(dir) {
  return path.join(dir, SNAPSHOT_FILE);
}

export function readLog(dir) {
  const file = logPath(dir);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

export function readSnapshot(dir) {
  const file = snapshotPath(dir);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function appendLogEntry(dir, entry) {
  fs.mkdirSync(dir, { recursive: true });
  const fd = fs.openSync(logPath(dir), 'a');
  try {
    fs.writeSync(fd, `${JSON.stringify(entry)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function writeSnapshot(dir, version, state) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${snapshotPath(dir)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version, state }));
  fs.renameSync(tmp, snapshotPath(dir));
}

function replayUntil(entries, targetVersion) {
  const state = emptyState();
  for (const entry of entries) {
    if (entry.version > targetVersion) break;
    for (const event of entry.events) applyToState(state, event);
  }
  return state;
}

// Loads the snapshot, then replays any log entries newer than the snapshot.
// This is the recovery path used after a crash between append and snapshot.
export function recover(dir) {
  const snapshot = readSnapshot(dir);
  const entries = readLog(dir);
  const state = snapshot ? snapshot.state : emptyState();
  let version = snapshot ? snapshot.version : 0;
  let recovered = false;
  for (const entry of entries) {
    if (entry.version <= version) continue;
    for (const event of entry.events) applyToState(state, event);
    version = entry.version;
    recovered = true;
  }
  return { state, version, recovered, entries, snapshotVersion: snapshot ? snapshot.version : null };
}

// Validates and applies a transaction. Fail points simulate crashes:
//   before_append: nothing is persisted at all
//   after_append:  the log entry is durable but no snapshot is written
export function applyEvents(dir, rawEvents, { fail: failPoint = null } = {}) {
  if (!Array.isArray(rawEvents) || rawEvents.length === 0) {
    fail('event file must contain a non-empty array of events');
  }
  const events = rawEvents.map(normalizeEvent);
  const { state, version } = recover(dir);
  const working = structuredClone(state);
  const logged = events.map((event) => ({ ...event, prev: applyToState(working, event) }));
  if (failPoint === 'before_append') {
    fail('injected failure before_append: transaction aborted before log append');
  }
  const newVersion = version + 1;
  appendLogEntry(dir, { version: newVersion, events: logged });
  if (failPoint === 'after_append') {
    fail('injected failure after_append: log appended, snapshot missing');
  }
  writeSnapshot(dir, newVersion, working);
  return { version: newVersion, applied: logged.length };
}

function computeReport(state) {
  const workOrders = Object.values(state.work_order);
  const bom = Object.values(state.bom);
  const inventory = Object.values(state.inventory);
  const gross = grossRequirements(workOrders, bom);
  const reference = referenceGross(workOrders, bom);
  const net = netRequirements(gross, inventory);
  return { gross, net, referenceGross: reference.gross, paths: reference.paths };
}

function diffNet(prev, curr) {
  const keys = [...new Set([...prev.keys(), ...curr.keys()])].sort();
  const delta = {};
  for (const key of keys) {
    const previous = prev.has(key) ? prev.get(key) : null;
    const current = curr.has(key) ? curr.get(key) : null;
    delta[key] = {
      previous,
      current,
      delta: previous !== null && current !== null ? current - previous : null,
    };
  }
  return delta;
}

function inputCertificate(dir) {
  const file = logPath(dir);
  const data = fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0);
  return `sha256:${crypto.createHash('sha256').update(data).digest('hex')}`;
}

export function query(dir) {
  const { state, version, recovered, entries, snapshotVersion } = recover(dir);
  const current = computeReport(state);
  const previous = computeReport(replayUntil(entries, version - 1));
  return {
    version,
    recovered,
    snapshot_version: snapshotVersion,
    gross: toSortedObject(current.gross),
    net: toSortedObject(current.net),
    reference_gross: toSortedObject(current.referenceGross),
    delta: diffNet(previous.net, current.net),
    certificate: inputCertificate(dir),
  };
}

export function listPaths(dir) {
  const { state, version } = recover(dir);
  const report = computeReport(state);
  return {
    version,
    count: report.paths.length,
    reference_gross: toSortedObject(report.referenceGross),
    paths: report.paths,
  };
}
