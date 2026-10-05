'use strict';
// Append-only NDJSON operation log.
const fs = require('fs');

const TYPES = new Set(['freeze', 'hold', 'release', 'unhold']);

function validateOp(rec) {
  if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) return 'record must be an object';
  if (typeof rec.opId !== 'string' || rec.opId.length === 0) return 'opId must be a non-empty string';
  if (typeof rec.account !== 'string' || rec.account.length === 0) return 'account must be a non-empty string';
  if (!TYPES.has(rec.type)) return `type must be one of ${[...TYPES].join(', ')}`;
  if (!Number.isInteger(rec.amount) || rec.amount <= 0) return 'amount must be a positive integer';
  if (rec.type !== 'freeze' && (typeof rec.freezeId !== 'string' || rec.freezeId.length === 0)) {
    return `${rec.type} requires a freezeId`;
  }
  if (!Number.isInteger(rec.ts)) return 'ts must be an integer';
  if (!Number.isInteger(rec.day) || rec.day < 0) return 'day must be a non-negative integer';
  if (rec.deps !== undefined && (!Array.isArray(rec.deps) || rec.deps.some((d) => typeof d !== 'string'))) {
    return 'deps must be an array of opIds';
  }
  if (rec.compensates !== undefined && typeof rec.compensates !== 'string') return 'compensates must be an opId string';
  return null;
}

// Reads the log. Blank lines are skipped; unparseable lines (e.g. a torn tail
// left by a crash mid-append) are skipped and reported as warnings so that
// recovery can proceed.
function readHistory(path) {
  const records = [];
  const warnings = [];
  if (!fs.existsSync(path)) return { records, warnings };
  const text = fs.readFileSync(path, 'utf8');
  text.split('\n').forEach((line, i) => {
    const t = line.trim();
    if (t === '') return;
    try {
      records.push(JSON.parse(t));
    } catch (e) {
      warnings.push(`line ${i + 1}: skipped unparseable record (${e.message})`);
    }
  });
  return { records, warnings };
}

// Appends one record as a single line and fsyncs. If a previous crash left a
// torn tail (no trailing newline), a newline is inserted first so the corrupt
// fragment stays isolated on its own line.
function appendRecord(path, rec) {
  const err = validateOp(rec);
  if (err) throw new Error(`invalid operation: ${err}`);
  const fd = fs.openSync(path, 'a+');
  try {
    const st = fs.fstatSync(fd);
    if (st.size > 0) {
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, st.size - 1);
      if (last[0] !== 0x0a) fs.writeSync(fd, '\n');
    }
    fs.writeSync(fd, JSON.stringify(rec) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { TYPES, validateOp, readHistory, appendRecord };
