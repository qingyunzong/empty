'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { GENESIS_HASH } = require('./chain');

function statePath(dir) {
  return path.join(dir, 'state.json');
}

function initialState() {
  return { accounts: {}, payments: {}, lastBatch: 0, lastHash: GENESIS_HASH, counter: 0 };
}

function loadState(dir) {
  const p = statePath(dir);
  if (!fs.existsSync(p)) return initialState();
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function saveState(dir, state) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${statePath(dir)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(tmp, statePath(dir));
}

module.exports = { loadState, saveState, initialState, statePath };
