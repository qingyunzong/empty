import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildSnapshot, normJson, computeHash } from './snapshot.js';
import { fail } from './errors.js';

function setPath(obj, dotPath, value) {
  const parts = dotPath.split('.');
  let o = obj;
  for (const part of parts.slice(0, -1)) {
    if (typeof o[part] !== 'object' || o[part] === null) o[part] = {};
    o = o[part];
  }
  o[parts[parts.length - 1]] = value;
}

function unsetPath(obj, dotPath) {
  const parts = dotPath.split('.');
  let o = obj;
  for (const part of parts.slice(0, -1)) {
    o = o?.[part];
    if (typeof o !== 'object' || o === null) return;
  }
  delete o[parts[parts.length - 1]];
}

// set/unset are idempotent, so journal replay after a crash is safe.
export function applyChange(params, change) {
  const next = structuredClone(params);
  for (const [p, v] of Object.entries(change.set ?? {})) setPath(next, p, v);
  for (const p of change.unset ?? []) unsetPath(next, p);
  return next;
}

export function validateChange(change) {
  if (!change || typeof change !== 'object') fail('E_PATCH', 'change.json must be an object');
  if (change.set !== undefined && (typeof change.set !== 'object' || change.set === null)) {
    fail('E_PATCH', 'change.set must be an object of dot.path -> value');
  }
  if (change.unset !== undefined && !Array.isArray(change.unset)) {
    fail('E_PATCH', 'change.unset must be an array of dot.paths');
  }
  return { set: change.set ?? {}, unset: change.unset ?? [] };
}

function updateSnapshotParams(store, runDir) {
  const name = path.basename(path.resolve(runDir));
  const params = JSON.parse(fs.readFileSync(path.join(runDir, 'params.json'), 'utf8'));
  let snap = null;
  try {
    snap = store.loadSnapshot(name);
  } catch { /* no snapshot yet: build a full one */ }
  if (snap) {
    // Incremental: tables are untouched by a parameter patch, so only the
    // params section and the content hash are recomputed.
    snap.params = normJson(params);
    snap.hash = computeHash(snap);
    store.saveSnapshot(snap);
  } else {
    store.saveSnapshot(buildSnapshot(runDir, name));
  }
  return name;
}

// Two-phase, journaled patch:
//   1. write journal (prepared)
//   2. apply change to params.json atomically (journal: params-applied)
//   3. update snapshot index incrementally
//   4. remove journal
// A crash between 2 and 3 leaves a journal that recover() replays.
export function patchRun(store, runDir, change, { crashAfter } = {}) {
  const validated = validateChange(change);
  const id = crypto.createHash('sha256')
    .update(JSON.stringify([path.resolve(runDir), validated, Date.now(), process.pid]))
    .digest('hex').slice(0, 16);
  const journal = { id, runDir: path.resolve(runDir), change: validated, state: 'prepared' };
  store.writeJournal(journal);
  const paramsPath = path.join(runDir, 'params.json');
  let params;
  try {
    params = JSON.parse(fs.readFileSync(paramsPath, 'utf8'));
  } catch (e) {
    store.removeJournal(id);
    fail('E_SNAP', `cannot read params.json in ${runDir}: ${e.message}`);
  }
  const next = applyChange(params, validated);
  store.atomicWrite(paramsPath, JSON.stringify(next, null, 2) + '\n');
  journal.state = 'params-applied';
  store.writeJournal(journal);
  if (crashAfter === 'params') {
    // Simulated crash: params applied, snapshot index not yet updated.
    process.exit(3);
  }
  const name = updateSnapshotParams(store, runDir);
  store.removeJournal(id);
  return { id, snapshot: name };
}

// Replay any interrupted patches. Idempotent: safe to run repeatedly.
export function recover(store) {
  const recovered = [];
  for (const j of store.listJournals()) {
    const paramsPath = path.join(j.runDir, 'params.json');
    const params = JSON.parse(fs.readFileSync(paramsPath, 'utf8'));
    const next = applyChange(params, j.change);
    store.atomicWrite(paramsPath, JSON.stringify(next, null, 2) + '\n');
    updateSnapshotParams(store, j.runDir);
    store.removeJournal(j.id);
    recovered.push(j.id);
  }
  return recovered;
}
