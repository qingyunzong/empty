'use strict';
const { sha256, canonical } = require('./util');
const { loadChangeset } = require('./changeset');
const { reduceEvents } = require('./reduce');
const { freshDb, loadDb, writeDb } = require('./store');
const { loadCheckpoint, writeCheckpoint } = require('./checkpoint');
const { merkleRoot } = require('./merkle');

function planBatches(entries, batchSize) {
  const batches = [];
  for (let i = 0; i < entries.length; i += batchSize) {
    batches.push(entries.slice(i, i + batchSize));
  }
  return batches;
}

function applyEntry(db, entry) {
  if (entry.type === 'delete') {
    delete db.events[entry.txId];
  } else {
    db.events[entry.txId] = entry.record;
  }
}

function stateHashOf(db) {
  return sha256(canonical(db.state));
}

function buildCert(checkpoint, db) {
  return {
    version: 1,
    merkleRoot: merkleRoot(checkpoint.rowHashes),
    coverage: checkpoint.coverage,
    batchCount: checkpoint.batchCount,
    rowCount: checkpoint.rowHashes.length,
    stateHash: stateHashOf(db),
  };
}

function runApply({ changesetPath, dbPath, checkpointPath, certPath, batchSize = 1000, resume = false, hook = null }) {
  const changeset = loadChangeset(changesetPath);
  const batches = planBatches(changeset.entries, batchSize);

  let db = freshDb();
  let checkpoint = null;
  let start = 0;
  if (resume) {
    checkpoint = loadCheckpoint(checkpointPath);
    if (checkpoint) {
      db = loadDb(dbPath);
      start = checkpoint.committedBatches;
    }
  }

  const fire = (phase, index) => { if (hook) hook(phase, index); };

  if (checkpoint && start >= batches.length) {
    const cert = buildCert(checkpoint, db);
    if (certPath) {
      fire('cert', 0);
      const { writeJsonSync } = require('./util');
      writeJsonSync(certPath, cert);
    }
    return { status: 'already-committed', redone: 0, committedBatches: start, batchCount: batches.length, cert };
  }

  const rowHashes = checkpoint ? checkpoint.rowHashes.slice() : [];
  let coverage = checkpoint ? checkpoint.coverage : null;

  for (let i = start; i < batches.length; i += 1) {
    for (const entry of batches[i]) {
      applyEntry(db, entry);
      rowHashes.push(entry.hash);
      if (coverage === null) coverage = [entry.seq, entry.seq];
      else coverage = [Math.min(coverage[0], entry.seq), Math.max(coverage[1], entry.seq)];
    }
    db.state = reduceEvents(Object.values(db.events), { enforceNonNegative: false });
    db.meta = { committedBatches: i + 1 };
    writeDb(dbPath, db);
    fire('db', i);

    checkpoint = {
      committedBatches: i + 1,
      batchCount: batches.length,
      rowHashes: rowHashes.slice(),
      coverage,
      stateHash: stateHashOf(db),
    };
    writeCheckpoint(checkpointPath, checkpoint);
    fire('checkpoint', i);
  }

  db.state = reduceEvents(Object.values(db.events), { enforceNonNegative: true });
  writeDb(dbPath, db);
  checkpoint.stateHash = stateHashOf(db);
  writeCheckpoint(checkpointPath, checkpoint);

  const cert = buildCert(checkpoint, db);
  if (certPath) {
    fire('cert', 0);
    const { writeJsonSync } = require('./util');
    writeJsonSync(certPath, cert);
  }
  return { status: 'ok', redone: batches.length - start, committedBatches: batches.length, batchCount: batches.length, cert };
}

module.exports = { runApply, planBatches, buildCert };
