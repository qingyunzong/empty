'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { scanDir } = require('./scan');

const SYNC_DIR = '.sync';
const STATE_FILE = 'state.json';

function statePath(dir) {
  return path.join(dir, SYNC_DIR, STATE_FILE);
}

function emptyState() {
  return { version: 1, files: {} };
}

function loadState(dir) {
  try {
    const s = JSON.parse(fs.readFileSync(statePath(dir), 'utf8'));
    if (!s || typeof s !== 'object' || !s.files) return emptyState();
    return s;
  } catch (err) {
    if (err.code === 'ENOENT') return emptyState();
    throw err;
  }
}

function atomicWrite(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function saveState(dir, state) {
  fs.mkdirSync(path.join(dir, SYNC_DIR), { recursive: true });
  atomicWrite(statePath(dir), JSON.stringify(state, null, 2));
}

// Merge the two sides' state files. Normally identical; on divergence prefer
// tombstones (deletes must not be forgotten), otherwise prefer side A.
function mergeStates(stateA, stateB) {
  const files = {};
  const keys = new Set([...Object.keys(stateA.files), ...Object.keys(stateB.files)]);
  for (const key of keys) {
    const ea = stateA.files[key];
    const eb = stateB.files[key];
    if (ea && eb) {
      files[key] = ea.deleted && !eb.deleted ? ea : !ea.deleted && eb.deleted ? eb : ea;
    } else {
      files[key] = ea || eb;
    }
  }
  return { version: 1, files };
}

// Rebuild identical state for both dirs after a mutation round.
// Active entries come from current scans; keys that vanished since the
// pre-mutation scans become tombstones; old tombstones are carried forward.
function rebuildStates(aDir, bDir, prevState, preScanA, preScanB) {
  const scanA = scanDir(aDir);
  const scanB = scanDir(bDir);
  const files = {};
  const keys = new Set([
    ...Object.keys(prevState.files),
    ...preScanA.keys(),
    ...preScanB.keys(),
    ...scanA.keys(),
    ...scanB.keys(),
  ]);
  for (const key of keys) {
    const a = scanA.get(key);
    const b = scanB.get(key);
    if (a || b) {
      const hash = (a || b).hash;
      files[key] = {
        hash,
        deleted: false,
        vector: { a: a ? a.mtimeMs : 0, b: b ? b.mtimeMs : 0 },
      };
    } else {
      const prev = prevState.files[key];
      const lastHash = prev && prev.hash ? prev.hash
        : preScanA.get(key) ? preScanA.get(key).hash
        : preScanB.get(key) ? preScanB.get(key).hash
        : null;
      if (lastHash) files[key] = { hash: lastHash, deleted: true, vector: { a: 0, b: 0 } };
    }
  }
  const state = { version: 1, files };
  saveState(aDir, state);
  saveState(bDir, state);
  return state;
}

module.exports = { SYNC_DIR, loadState, saveState, mergeStates, rebuildStates, emptyState };
