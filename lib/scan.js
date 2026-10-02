'use strict';
const fs = require('node:fs');
const { readJsonSync, writeJsonSync } = require('./util');
const { readJournal } = require('./journal');

function loadSnapshot(snapshotPath) {
  if (!fs.existsSync(snapshotPath)) return { lines: [] };
  const snap = readJsonSync(snapshotPath);
  if (!Array.isArray(snap.lines)) return { lines: [] };
  return snap;
}

function scan({ journalPath, snapshotPath, changesetPath }) {
  const { records, hashes } = readJournal(journalPath);
  const prev = loadSnapshot(snapshotPath);
  const entries = [];
  let added = 0;
  let modified = 0;
  let deleted = 0;

  for (let i = 0; i < records.length; i += 1) {
    const rec = records[i];
    const hash = hashes[i];
    if (i >= prev.lines.length) {
      entries.push({ type: 'add', seq: rec.seq, txId: rec.txId, hash, record: rec });
      added += 1;
    } else if (prev.lines[i].hash !== hash) {
      entries.push({ type: 'modify', seq: rec.seq, txId: rec.txId, hash, record: rec });
      modified += 1;
    }
  }
  for (let i = records.length; i < prev.lines.length; i += 1) {
    entries.push({ type: 'delete', seq: i + 1, txId: prev.lines[i].txId, hash: prev.lines[i].hash, record: null });
    deleted += 1;
  }

  const changeset = { version: 1, entries };
  writeJsonSync(changesetPath, changeset);
  const snapshot = { lines: records.map((rec, i) => ({ seq: rec.seq, txId: rec.txId, hash: hashes[i] })) };
  writeJsonSync(snapshotPath, snapshot);
  return { added, modified, deleted, total: records.length, entries: entries.length };
}

module.exports = { scan };
