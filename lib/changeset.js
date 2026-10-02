'use strict';
const fs = require('node:fs');
const { SyncError, readJsonSync, hashRecord } = require('./util');
const { validateRecord } = require('./journal');

function loadChangeset(path) {
  if (!fs.existsSync(path)) {
    throw new SyncError('CHANGESET_NOT_FOUND', `changeset not found: ${path}`, { path });
  }
  const cs = readJsonSync(path);
  if (!cs || !Array.isArray(cs.entries)) {
    throw new SyncError('BAD_CHANGESET', `changeset ${path} has no entries array`, { path });
  }
  cs.entries.forEach((entry, idx) => {
    if (!entry || typeof entry !== 'object' || !['add', 'modify', 'delete'].includes(entry.type)) {
      throw new SyncError('BAD_CHANGESET', `changeset entry ${idx} has invalid type`, { entry: idx });
    }
    if (entry.type === 'delete') return;
    if (!entry.record || typeof entry.record !== 'object') {
      throw new SyncError('MISSING_LINE', `changeset entry ${idx} (${entry.type}) has no record`, { entry: idx });
    }
    validateRecord(entry.record, entry.record.seq);
    const actual = hashRecord(entry.record);
    if (actual !== entry.hash) {
      throw new SyncError('HASH_MISMATCH', `changeset entry ${idx} hash mismatch: expected ${entry.hash}, got ${actual}`, {
        entry: idx, txId: entry.record.txId, expected: entry.hash, got: actual,
      });
    }
  });
  return cs;
}

module.exports = { loadChangeset };
