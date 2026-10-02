'use strict';
const fs = require('node:fs');
const { readJsonSync, writeJsonSync } = require('./util');

function loadCheckpoint(path) {
  if (!fs.existsSync(path)) return null;
  return readJsonSync(path);
}

function writeCheckpoint(path, checkpoint) {
  writeJsonSync(path, checkpoint);
}

module.exports = { loadCheckpoint, writeCheckpoint };
