'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { applyDataOp, validatePatch } = require('./ops');
const { loadState, saveStateAtomic, STATE_TMP } = require('./state');
const { readJournal, writeJournal, removeJournal, cleanTemps } = require('./journal');

// Simulates a hard crash: a partially written temp file is left behind and
// the process exits immediately without any cleanup (like a power loss).
function simulateCrash(pkgDir) {
  fs.writeFileSync(path.join(pkgDir, STATE_TMP), '{"partial":');
  process.exit(2);
}

function finalize(pkgDir) {
  removeJournal(pkgDir);
  cleanTemps(pkgDir);
}

// Applies a patch transactionally. Any validation failure throws PatchError
// before a single byte is written to the package directory.
function applyPatch(pkgDir, patch, options = {}) {
  const failAt = options.failAt === undefined ? null : options.failAt;

  // A leftover journal means the previous run crashed: recover first.
  recover(pkgDir);

  const state = loadState(pkgDir);
  const undo = validatePatch(state, patch.ops);

  const journal = {
    status: 'applying',
    appliedCount: 0,
    ops: patch.ops,
    undo,
    baseVersion: state.version,
  };
  writeJournal(pkgDir, journal);

  const current = state;
  for (let i = 0; i < patch.ops.length; i++) {
    applyDataOp(current, patch.ops[i]);
    current.version += 1;
    saveStateAtomic(pkgDir, current);
    journal.appliedCount = i + 1;
    writeJournal(pkgDir, journal);
    if (failAt === i + 1) simulateCrash(pkgDir);
  }

  journal.status = 'committed';
  writeJournal(pkgDir, journal);
  if (failAt === patch.ops.length + 1) simulateCrash(pkgDir);

  finalize(pkgDir);
  return { committed: true, applied: patch.ops.length, version: current.version };
}

// Recovery after a crash, driven by the journal:
//  - status "committed" or all ops applied  -> roll forward (finish the commit)
//  - otherwise                              -> roll back applied ops via their
//    inverses, restoring the exact pre-commit state
// Either way, temporary files and the journal are removed.
function recover(pkgDir) {
  const journal = readJournal(pkgDir);
  if (!journal) {
    cleanTemps(pkgDir);
    return { recovered: false };
  }

  if (journal.status === 'committed' || journal.appliedCount >= journal.ops.length) {
    finalize(pkgDir);
    return { recovered: true, action: 'rolled-forward', version: loadState(pkgDir).version };
  }

  const state = loadState(pkgDir);
  for (let i = journal.appliedCount - 1; i >= 0; i--) {
    applyDataOp(state, journal.undo[i]);
    state.version -= 1;
  }
  saveStateAtomic(pkgDir, state);
  finalize(pkgDir);
  return { recovered: true, action: 'rolled-back', version: state.version };
}

module.exports = { applyPatch, recover };
