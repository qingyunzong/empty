'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { hashFile } = require('./hash');
const { scanDir } = require('./scan');
const { loadState, mergeStates, rebuildStates, SYNC_DIR } = require('./state');

const ERR_READ_ONLY_TARGET = 60;
const DEFAULT_CHUNK = 64 * 1024;

class SyncError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function sleepMs(ms) {
  if (ms <= 0) return;
  const ia = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(ia, 0, 0, ms);
}

function isReadOnlyErr(err) {
  return err && (err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'EROFS');
}

function probeWritable(dir) {
  try {
    fs.mkdirSync(path.join(dir, SYNC_DIR), { recursive: true });
    const probe = path.join(dir, SYNC_DIR, `.probe-${process.pid}`);
    const fd = fs.openSync(probe, 'w');
    fs.closeSync(fd);
    fs.unlinkSync(probe);
  } catch (err) {
    if (isReadOnlyErr(err)) throw new SyncError(ERR_READ_ONLY_TARGET, `read-only target: ${dir}`);
    throw err;
  }
}

function loadJournal(journalPath) {
  try {
    return JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  } catch {
    return {};
  }
}

function saveJournal(journalPath, journal) {
  const tmp = `${journalPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(journal));
  fs.renameSync(tmp, journalPath);
}

function copyOp(op, journal, journalPath, opts, stats) {
  const { src, dst, hash, size } = op;
  // Idempotency: destination already holds the exact content.
  if (fs.existsSync(dst) && hashFile(dst) === hash) {
    journal[op.id] = { status: 'done', note: 'already-converged' };
    saveJournal(journalPath, journal);
    stats.skipped++;
    return { id: op.id, status: 'skipped', reason: 'already-converged' };
  }
  const tmp = `${dst}.part`;
  let offset = 0;
  const entry = journal[op.id];
  if (entry && entry.status === 'in-progress' && entry.size === size && fs.existsSync(tmp)) {
    if (fs.statSync(tmp).size === entry.confirmedBytes) offset = entry.confirmedBytes;
  }
  if (offset === 0 && fs.existsSync(tmp)) fs.unlinkSync(tmp);

  let fdIn, fdOut;
  try {
    fdIn = fs.openSync(src, 'r');
    fdOut = fs.openSync(tmp, offset > 0 ? 'r+' : 'w');
  } catch (err) {
    if (isReadOnlyErr(err)) throw new SyncError(ERR_READ_ONLY_TARGET, `read-only target: ${dst}`);
    throw err;
  }
  const chunkSize = opts.chunkSize || DEFAULT_CHUNK;
  const buf = Buffer.alloc(chunkSize);
  let pos = offset;
  try {
    while (pos < size) {
      const want = Math.min(chunkSize, size - pos);
      const n = fs.readSync(fdIn, buf, 0, want, pos);
      if (n <= 0) break;
      try {
        fs.writeSync(fdOut, buf, 0, n, pos);
        fs.fsyncSync(fdOut);
      } catch (err) {
        if (isReadOnlyErr(err)) throw new SyncError(ERR_READ_ONLY_TARGET, `read-only target: ${dst}`);
        throw err;
      }
      pos += n;
      journal[op.id] = { status: 'in-progress', confirmedBytes: pos, size, tmp };
      saveJournal(journalPath, journal);
      if (opts.chunkDelayMs) sleepMs(opts.chunkDelayMs);
    }
    fs.fsyncSync(fdOut);
  } finally {
    fs.closeSync(fdIn);
    fs.closeSync(fdOut);
  }
  if (pos !== size || hashFile(tmp) !== hash) {
    throw new Error(`copy verification failed for ${op.key}`);
  }
  try {
    fs.renameSync(tmp, dst);
  } catch (err) {
    if (isReadOnlyErr(err)) throw new SyncError(ERR_READ_ONLY_TARGET, `read-only target: ${dst}`);
    throw err;
  }
  journal[op.id] = { status: 'done', confirmedBytes: size };
  saveJournal(journalPath, journal);
  stats.copied++;
  stats.bytesWritten += size - offset;
  if (offset > 0) {
    stats.resumedBytes += offset;
    return { id: op.id, status: 'copied', resumedFrom: offset };
  }
  return { id: op.id, status: 'copied', resumedFrom: 0 };
}

function deleteOp(op, journal, journalPath, stats) {
  try {
    if (fs.existsSync(op.path)) fs.unlinkSync(op.path);
  } catch (err) {
    if (isReadOnlyErr(err)) throw new SyncError(ERR_READ_ONLY_TARGET, `read-only target: ${op.path}`);
    throw err;
  }
  journal[op.id] = { status: 'done' };
  saveJournal(journalPath, journal);
  stats.deleted++;
  return { id: op.id, status: 'deleted' };
}

// Execute a plan. Interrupt-safe: confirmed chunks are journaled and never
// re-copied on resume. Idempotent: converged destinations are skipped.
function applyPlan(plan, opts = {}) {
  const journalPath = opts.journalPath || path.join(plan.aDir, SYNC_DIR, 'apply-journal.json');
  probeWritable(plan.aDir);
  probeWritable(plan.bDir);

  const preScanA = scanDir(plan.aDir);
  const preScanB = scanDir(plan.bDir);
  const prevState = mergeStates(loadState(plan.aDir), loadState(plan.bDir));

  const journal = loadJournal(journalPath);
  const stats = { copied: 0, deleted: 0, skipped: 0, bytesWritten: 0, resumedBytes: 0, results: [] };
  for (const op of plan.ops) {
    if (journal[op.id] && journal[op.id].status === 'done') {
      // Verify the effect is still in place; otherwise redo.
      if (op.op === 'copy' && fs.existsSync(op.dst) && hashFile(op.dst) === op.hash) {
        stats.skipped++;
        stats.results.push({ id: op.id, status: 'skipped', reason: 'journal-done' });
        continue;
      }
      if (op.op === 'delete' && !fs.existsSync(op.path)) {
        stats.skipped++;
        stats.results.push({ id: op.id, status: 'skipped', reason: 'journal-done' });
        continue;
      }
    }
    const r = op.op === 'copy'
      ? copyOp(op, journal, journalPath, opts, stats)
      : deleteOp(op, journal, journalPath, stats);
    stats.results.push(r);
  }

  rebuildStates(plan.aDir, plan.bDir, prevState, preScanA, preScanB);
  return stats;
}

module.exports = { applyPlan, SyncError, ERR_READ_ONLY_TARGET, DEFAULT_CHUNK };
