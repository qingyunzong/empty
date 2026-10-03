'use strict';

const fs = require('node:fs');
const path = require('node:path');

const STATE_FILE = 'state.json';
const JOURNAL_FILE = 'journal.json';
const STATE_TMP_FILE = 'state.json.tmp';

const KNOWN_OPS = new Set([
  'set-attr',
  'delete-attr',
  'put-file',
  'delete-file',
  'append-chain',
]);

// Ops that destroy existing data; they are rejected unless an inverse op
// is supplied so the change can always be undone.
const DANGEROUS_OPS = new Set(['delete-attr', 'delete-file']);

class RejectError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RejectError';
  }
}

function statePath(dir) {
  return path.join(dir, STATE_FILE);
}

function journalPath(dir) {
  return path.join(dir, JOURNAL_FILE);
}

function stateTmpPath(dir) {
  return path.join(dir, STATE_TMP_FILE);
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function initialState() {
  return { version: 0, files: {}, attributes: {}, chain: [] };
}

function initDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(statePath(dir))) {
    writeJson(statePath(dir), initialState());
  }
}

function loadState(dir) {
  return readJson(statePath(dir));
}

// Remove any temp files left over from an interrupted apply.
function cleanupTempFiles(dir) {
  for (const entry of fs.readdirSync(dir)) {
    if (entry.endsWith('.tmp')) {
      fs.rmSync(path.join(dir, entry), { force: true });
    }
  }
}

function validateOp(op, index) {
  if (op === null || typeof op !== 'object' || Array.isArray(op)) {
    throw new RejectError(`op ${index}: not an object`);
  }
  if (!KNOWN_OPS.has(op.type)) {
    throw new RejectError(`op ${index}: unknown op type ${JSON.stringify(op.type)}`);
  }
  if (!Number.isInteger(op.expectVersion) || op.expectVersion < 0) {
    throw new RejectError(`op ${index}: missing or invalid expectVersion`);
  }
  if (DANGEROUS_OPS.has(op.type) && op.inverse === undefined) {
    throw new RejectError(`op ${index}: dangerous op ${op.type} requires an inverse`);
  }
  if (op.inverse !== undefined) {
    if (
      op.inverse === null ||
      typeof op.inverse !== 'object' ||
      !KNOWN_OPS.has(op.inverse.type)
    ) {
      throw new RejectError(`op ${index}: inverse has unknown op type`);
    }
  }
  switch (op.type) {
    case 'set-attr':
      if (typeof op.key !== 'string') throw new RejectError(`op ${index}: set-attr needs key`);
      break;
    case 'delete-attr':
      if (typeof op.key !== 'string') throw new RejectError(`op ${index}: delete-attr needs key`);
      break;
    case 'put-file':
      if (typeof op.path !== 'string') throw new RejectError(`op ${index}: put-file needs path`);
      break;
    case 'delete-file':
      if (typeof op.path !== 'string') throw new RejectError(`op ${index}: delete-file needs path`);
      break;
    case 'append-chain':
      if (op.entry === undefined) throw new RejectError(`op ${index}: append-chain needs entry`);
      break;
  }
}

// Validate the whole patch up front. Nothing is written before this passes,
// so rejected patches never touch the disk.
function validatePatch(patch, baseVersion) {
  if (patch === null || typeof patch !== 'object' || !Array.isArray(patch.ops)) {
    throw new RejectError('patch must be an object with an ops array');
  }
  patch.ops.forEach((op, index) => {
    validateOp(op, index);
    if (op.expectVersion !== baseVersion + index) {
      throw new RejectError(
        `op ${index}: conditional version mismatch, expected state version ` +
          `${op.expectVersion} but patch position requires ${baseVersion + index}`
      );
    }
  });
}

function applyOp(state, op) {
  switch (op.type) {
    case 'set-attr':
      state.attributes[op.key] = op.value;
      break;
    case 'delete-attr':
      delete state.attributes[op.key];
      break;
    case 'put-file':
      state.files[op.path] = op.content;
      break;
    case 'delete-file':
      delete state.files[op.path];
      break;
    case 'append-chain':
      state.chain.push(op.entry);
      break;
    default:
      throw new RejectError(`unknown op type ${JSON.stringify(op.type)}`);
  }
  state.version += 1;
}

// Write-ahead-log apply: validate everything, journal the intent, then apply
// op by op into state.json.tmp, recording progress in journal.json after each
// op. Only when every op succeeded is the tmp file renamed over state.json
// and the journal marked committed.
//
// opts.failAt (1-based) simulates a crash: the function returns right after
// the Nth op has been journaled, leaving journal + tmp on disk.
function applyPatch(dir, patch, opts = {}) {
  recover(dir); // auto-recover any interrupted previous patch first

  const state = loadState(dir);
  validatePatch(patch, state.version);

  const journal = {
    status: 'pending',
    baseVersion: state.version,
    completed: 0,
    ops: patch.ops,
  };
  writeJson(journalPath(dir), journal);

  const working = clone(state);
  for (let index = 0; index < patch.ops.length; index += 1) {
    applyOp(working, patch.ops[index]);
    writeJson(stateTmpPath(dir), working);
    journal.completed = index + 1;
    writeJson(journalPath(dir), journal);
    if (opts.failAt === index + 1) {
      return { crashed: true, completed: journal.completed };
    }
  }

  fs.renameSync(stateTmpPath(dir), statePath(dir));
  journal.status = 'committed';
  writeJson(journalPath(dir), journal);
  cleanupTempFiles(dir);
  return { crashed: false, committed: true, completed: journal.completed };
}

// Recovery, driven purely by journal.json:
//  - no pending journal        -> nothing to do
//  - all applied ops invertible -> roll back to the pre-commit state
//  - otherwise                  -> roll forward and finish the commit
// Either way the resulting state is deterministic and no temp files remain.
function recover(dir) {
  cleanupTempFilesOrphanedOnly(dir);
  const jPath = journalPath(dir);
  if (!fs.existsSync(jPath)) {
    return 'none';
  }
  const journal = readJson(jPath);
  if (journal.status !== 'pending') {
    cleanupTempFiles(dir);
    return 'none';
  }

  const appliedOps = journal.ops.slice(0, journal.completed);
  const canRollBack = appliedOps.every((op) => op.inverse !== undefined);

  if (canRollBack) {
    // state.json was never modified during the apply phase (all work went
    // to the tmp file), so rolling back means discarding the tmp file.
    cleanupTempFiles(dir);
    journal.status = 'rolled-back';
    writeJson(jPath, journal);
    return 'rolled-back';
  }

  // Roll forward: replay every journaled op onto the pre-commit state and
  // commit the result atomically.
  const working = loadState(dir);
  for (const op of journal.ops) {
    applyOp(working, op);
  }
  writeJson(stateTmpPath(dir), working);
  fs.renameSync(stateTmpPath(dir), statePath(dir));
  journal.status = 'committed';
  writeJson(jPath, journal);
  cleanupTempFiles(dir);
  return 'rolled-forward';
}

function cleanupTempFilesOrphanedOnly(dir) {
  if (fs.existsSync(dir)) {
    cleanupTempFiles(dir);
  }
}

module.exports = {
  STATE_FILE,
  JOURNAL_FILE,
  STATE_TMP_FILE,
  RejectError,
  initDir,
  initialState,
  loadState,
  validatePatch,
  applyPatch,
  recover,
  cleanupTempFiles,
};
