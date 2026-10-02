'use strict';

const fs = require('node:fs');
const path = require('node:path');

function readLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function positionPath(stateDir) {
  return path.join(stateDir, 'position.json');
}

function ledgerPath(stateDir) {
  return path.join(stateDir, 'ledger.ndjson');
}

function readPosition(stateDir) {
  const p = positionPath(stateDir);
  if (!fs.existsSync(p)) return { txOffset: 0 };
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// Atomic checkpoint: write tmp, fsync, rename. A crash before the rename
// leaves the previous committed position intact.
function writePosition(stateDir, position) {
  fs.mkdirSync(stateDir, { recursive: true });
  const tmp = positionPath(stateDir) + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(position) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, positionPath(stateDir));
}

// Load ledger entries; dedupe by txId keeping the last occurrence so a
// crash between ledger append and checkpoint never yields duplicates.
function loadLedger(stateDir) {
  const map = new Map();
  for (const line of readLines(ledgerPath(stateDir))) {
    const entry = JSON.parse(line);
    map.set(entry.txId, entry);
  }
  return map;
}

function appendLedger(stateDir, entries) {
  if (entries.length === 0) return;
  fs.mkdirSync(stateDir, { recursive: true });
  const fd = fs.openSync(ledgerPath(stateDir), 'a');
  try {
    for (const e of entries) fs.writeSync(fd, JSON.stringify(e) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { readLines, readPosition, writePosition, loadLedger, appendLedger, ledgerPath, positionPath };
