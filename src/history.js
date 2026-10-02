'use strict';

const fs = require('fs');
const path = require('path');
const { ERR_DUPLICATE_OPID, CODE_NAMES } = require('./sim');

const DEFAULT_HISTORY = 'history.ndjson';

/** Read an ndjson history file into an array of ops (blank lines skipped). */
function readHistory(file = DEFAULT_HISTORY) {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  const ops = [];
  text.split('\n').forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      ops.push(JSON.parse(trimmed));
    } catch (err) {
      throw new Error(`${file}:${i + 1}: invalid JSON line: ${err.message}`);
    }
  });
  return ops;
}

/** Append one op as a single ndjson line and fsync (crash-safe append). */
function appendLine(file, op) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const fd = fs.openSync(file, 'a');
  try {
    fs.writeSync(fd, JSON.stringify(op) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Append an op to the history. Rejects duplicate opIds with code 12.
 * Fills ts (ms epoch) and day (UTC) when absent. Returns the stored op.
 */
function appendOp(file, op) {
  const existing = new Set(readHistory(file).map((o) => o.opId));
  if (op.opId != null && existing.has(op.opId)) {
    const err = new Error(`duplicate opId: ${op.opId}`);
    err.code = ERR_DUPLICATE_OPID;
    err.reason = CODE_NAMES[ERR_DUPLICATE_OPID];
    throw err;
  }
  const stored = { ...op };
  if (stored.opId == null) stored.opId = genOpId();
  if (stored.ts == null) stored.ts = Date.now();
  if (stored.day == null) stored.day = new Date(stored.ts).toISOString().slice(0, 10);
  if (stored.causes == null) stored.causes = [];
  appendLine(file, stored);
  return stored;
}

function genOpId() {
  return 'op-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

module.exports = { readHistory, appendLine, appendOp, genOpId, DEFAULT_HISTORY };
