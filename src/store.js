'use strict';

const fs = require('node:fs');
const { initialState } = require('./machine');

function loadState(path) {
  if (!fs.existsSync(path)) {
    return initialState();
  }
  const raw = fs.readFileSync(path, 'utf8');
  return JSON.parse(raw);
}

function saveState(path, state) {
  const tmp = `${path}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, path);
}

module.exports = { loadState, saveState };
