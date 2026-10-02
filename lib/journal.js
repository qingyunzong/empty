'use strict';
const fs = require('node:fs');
const { SyncError, hashRecord } = require('./util');

const OPS = new Set(['credit', 'debit', 'undo']);

function validateRecord(rec, lineNo) {
  const at = { line: lineNo };
  if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) {
    throw new SyncError('BAD_RECORD', `line ${lineNo}: record must be an object`, at);
  }
  if (!Number.isInteger(rec.seq) || rec.seq < 1) {
    throw new SyncError('BAD_RECORD', `line ${lineNo}: seq must be a positive integer`, at);
  }
  if (typeof rec.txId !== 'string' || rec.txId.length === 0) {
    throw new SyncError('BAD_RECORD', `line ${lineNo}: txId must be a non-empty string`, at);
  }
  if (!OPS.has(rec.op)) {
    throw new SyncError('BAD_RECORD', `line ${lineNo}: op must be credit|debit|undo`, at);
  }
  if (rec.op === 'undo') {
    if (typeof rec.ref !== 'string' || rec.ref.length === 0) {
      throw new SyncError('BAD_RECORD', `line ${lineNo}: undo requires non-empty ref`, at);
    }
  } else {
    if (typeof rec.account !== 'string' || rec.account.length === 0) {
      throw new SyncError('BAD_RECORD', `line ${lineNo}: account must be a non-empty string`, at);
    }
    if (!Number.isInteger(rec.amount)) {
      throw new SyncError('INVALID_AMOUNT', `line ${lineNo}: amount must be integer cents`, { ...at, amount: rec.amount });
    }
    if (rec.amount < 0) {
      throw new SyncError('INVALID_AMOUNT', `line ${lineNo}: amount must be >= 0`, { ...at, amount: rec.amount });
    }
  }
}

function readJournal(path) {
  if (!fs.existsSync(path)) {
    throw new SyncError('JOURNAL_NOT_FOUND', `journal not found: ${path}`, { path });
  }
  const raw = fs.readFileSync(path, 'utf8');
  const lines = raw.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const records = [];
  const hashes = [];
  let expected = 1;
  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    if (line.trim() === '') {
      throw new SyncError('MISSING_LINE', `blank line at journal line ${lineNo}`, { line: lineNo });
    }
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      throw new SyncError('BAD_JSON', `line ${lineNo}: invalid JSON`, { line: lineNo });
    }
    validateRecord(rec, lineNo);
    if (rec.seq !== expected) {
      throw new SyncError('MISSING_LINE', `seq gap at line ${lineNo}: expected ${expected}, got ${rec.seq}`, {
        line: lineNo, expected, got: rec.seq,
      });
    }
    expected += 1;
    records.push(rec);
    hashes.push(hashRecord(rec));
  });
  return { records, hashes };
}

module.exports = { readJournal, validateRecord };
