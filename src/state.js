'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { PatchError } = require('./ops');

const STATE_FILE = 'state.json';
const STATE_TMP = 'state.json.tmp';

function statePath(pkgDir) {
  return path.join(pkgDir, STATE_FILE);
}

function loadState(pkgDir) {
  const file = statePath(pkgDir);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new PatchError(`cannot read state.json: ${err.message}`);
  }
  let state;
  try {
    state = JSON.parse(raw);
  } catch (err) {
    throw new PatchError(`state.json is not valid JSON: ${err.message}`);
  }
  if (
    state === null ||
    typeof state !== 'object' ||
    !Number.isInteger(state.version) ||
    state.attributes === null || typeof state.attributes !== 'object' || Array.isArray(state.attributes) ||
    state.files === null || typeof state.files !== 'object' || Array.isArray(state.files) ||
    !Array.isArray(state.chain)
  ) {
    throw new PatchError('state.json has an invalid shape (need {version, attributes, files, chain})');
  }
  return state;
}

// Atomic write: serialize to a temp file, fsync, then rename over state.json.
function saveStateAtomic(pkgDir, state) {
  const tmp = path.join(pkgDir, STATE_TMP);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(state, null, 2) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, statePath(pkgDir));
}

module.exports = { STATE_FILE, STATE_TMP, loadState, saveStateAtomic, statePath };
