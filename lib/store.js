'use strict';

const fs = require('node:fs');
const path = require('node:path');

function writeAtomic(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, `${JSON.stringify(obj, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function exists(filePath) {
  return fs.existsSync(filePath);
}

function statePaths(stateDir) {
  return {
    plan: path.join(stateDir, 'plan.json'),
    executed: path.join(stateDir, 'executed.json'),
    reverse: path.join(stateDir, 'reverse-plan.json'),
    rolledBack: path.join(stateDir, 'plan.rolledback.json'),
  };
}

module.exports = { writeAtomic, readJson, exists, statePaths };
