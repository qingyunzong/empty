// Log store: ingest, merge, snapshot, restore.
// Snapshots are canonical JSON with a SHA-256 integrity checksum; any
// truncation or tampering is detected on restore, which is pure and never
// mutates any existing in-memory store.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { compareLogs } from './compare.js';

export const MAGIC = 'shiftlog-snapshot';
export const VERSION = 1;

export function createStore() {
  return { logs: new Map() };
}

function invalid(errors) {
  return { status: 'INVALID_INPUT', errors };
}

function normalizeEvents(events) {
  const errors = [];
  if (!Array.isArray(events)) {
    return { errors: ['events must be an array'] };
  }
  const byId = new Map();
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const where = `events[${i}]`;
    if (e === null || typeof e !== 'object' || Array.isArray(e)) {
      errors.push(`${where}: must be an object`);
      continue;
    }
    if (typeof e.id !== 'string' || e.id.length === 0) {
      errors.push(`${where}: id must be a non-empty string`);
      continue;
    }
    const causes = e.causes === undefined ? [] : e.causes;
    if (!Array.isArray(causes) || causes.some((c) => typeof c !== 'string' || c.length === 0)) {
      errors.push(`${where}: causes must be an array of non-empty strings`);
      continue;
    }
    if (causes.includes(e.id)) {
      errors.push(`${where}: self-cause is not allowed (id=${e.id})`);
      continue;
    }
    const norm = [...new Set(causes)].sort();
    const prev = byId.get(e.id);
    if (prev !== undefined) {
      if (prev.join('') !== norm.join('')) {
        errors.push(`${where}: duplicate event id with conflicting causes (id=${e.id})`);
      }
      continue; // identical duplicate: dedupe
    }
    byId.set(e.id, norm);
  }
  if (errors.length > 0) return { errors };
  const normalized = [...byId.entries()]
    .map(([id, causes]) => ({ id, causes }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { normalized };
}

export function ingest(store, logId, events) {
  if (typeof logId !== 'string' || logId.length === 0) {
    return invalid(['log_id must be a non-empty string']);
  }
  if (store.logs.has(logId)) {
    return invalid([`duplicate log_id: ${logId}`]);
  }
  const { normalized, errors } = normalizeEvents(events);
  if (errors) return invalid(errors);
  store.logs.set(logId, normalized);
  return { status: 'OK', log_id: logId, events: normalized.length };
}

export function merge(store, a, b, newId = `${a}+${b}`) {
  const errors = [];
  if (!store.logs.has(a)) errors.push(`unknown log: ${a}`);
  if (!store.logs.has(b)) errors.push(`unknown log: ${b}`);
  if (errors.length > 0) return invalid(errors);
  if (typeof newId !== 'string' || newId.length === 0) {
    return invalid(['new log_id must be a non-empty string']);
  }
  if (store.logs.has(newId)) {
    return invalid([`duplicate log_id: ${newId}`]);
  }
  const combined = [...store.logs.get(a), ...store.logs.get(b)];
  const { normalized, errors: normErrors } = normalizeEvents(combined);
  if (normErrors) {
    return invalid(normErrors.map((e) => `merge conflict: ${e}`));
  }
  store.logs.set(newId, normalized);
  return { status: 'OK', log_id: newId, events: normalized.length };
}

function getEvents(store, logId) {
  return store.logs.get(logId);
}

export function equiv(store, a, b) {
  const ea = getEvents(store, a);
  const eb = getEvents(store, b);
  const errors = [];
  if (ea === undefined) errors.push(`unknown log: ${a}`);
  if (eb === undefined) errors.push(`unknown log: ${b}`);
  if (errors.length > 0) return invalid(errors);
  const r = compareLogs(ea, eb);
  const out = { status: r.status };
  if (r.status === 'NOT_EQUAL') {
    out.first_divergent = r.first_divergent;
    out.minimal_frontier = r.minimal_frontier;
  }
  if (r.status === 'UNDECIDED') {
    out.missing_edges = r.missing_edges;
  }
  return out;
}

export function explain(store, a, b) {
  const ea = getEvents(store, a);
  const eb = getEvents(store, b);
  const errors = [];
  if (ea === undefined) errors.push(`unknown log: ${a}`);
  if (eb === undefined) errors.push(`unknown log: ${b}`);
  if (errors.length > 0) return invalid(errors);
  return compareLogs(ea, eb);
}

function canonicalLogs(store) {
  const obj = {};
  for (const id of [...store.logs.keys()].sort()) {
    obj[id] = store.logs.get(id);
  }
  return JSON.stringify(obj);
}

export function snapshot(store) {
  const logsJson = canonicalLogs(store);
  const checksum = createHash('sha256').update(logsJson, 'utf8').digest('hex');
  return JSON.stringify({ magic: MAGIC, version: VERSION, checksum, logs: JSON.parse(logsJson) });
}

export function writeSnapshot(store, file) {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, snapshot(store));
  renameSync(tmp, file);
  return { status: 'OK', file };
}

function validateLogsShape(logs) {
  if (logs === null || typeof logs !== 'object' || Array.isArray(logs)) return false;
  for (const [logId, events] of Object.entries(logs)) {
    if (logId.length === 0) return false;
    if (!Array.isArray(events)) return false;
    for (const e of events) {
      if (e === null || typeof e !== 'object' || Array.isArray(e)) return false;
      if (typeof e.id !== 'string' || e.id.length === 0) return false;
      if (!Array.isArray(e.causes) || e.causes.some((c) => typeof c !== 'string' || c.length === 0)) {
        return false;
      }
      if (e.causes.includes(e.id)) return false;
    }
  }
  return true;
}

export function restoreFromString(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: 'RESTORE_CORRUPT', reason: 'not valid JSON' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 'RESTORE_CORRUPT', reason: 'snapshot must be an object' };
  }
  if (parsed.magic !== MAGIC) {
    return { status: 'RESTORE_CORRUPT', reason: 'bad magic' };
  }
  if (parsed.version !== VERSION) {
    return { status: 'RESTORE_CORRUPT', reason: `unsupported version: ${parsed.version}` };
  }
  if (typeof parsed.checksum !== 'string' || !validateLogsShape(parsed.logs)) {
    return { status: 'RESTORE_CORRUPT', reason: 'malformed logs' };
  }
  const store = createStore();
  for (const [logId, events] of Object.entries(parsed.logs)) {
    const { normalized, errors } = normalizeEvents(events);
    if (errors) return { status: 'RESTORE_CORRUPT', reason: `invalid events in log ${logId}` };
    store.logs.set(logId, normalized);
  }
  const checksum = createHash('sha256').update(canonicalLogs(store), 'utf8').digest('hex');
  if (checksum !== parsed.checksum) {
    return { status: 'RESTORE_CORRUPT', reason: 'checksum mismatch' };
  }
  return { status: 'OK', store };
}

export function restore(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    return { status: 'RESTORE_CORRUPT', reason: `cannot read file: ${err.code || err.message}` };
  }
  const r = restoreFromString(text);
  if (r.status === 'OK') return { status: 'OK', store: r.store, file };
  return r;
}
