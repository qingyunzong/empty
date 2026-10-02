import { dirname } from 'node:path';
import { openSync, writeSync, fsyncSync, closeSync, renameSync } from 'node:fs';
import { hashEvent } from './canonical.js';
import { rootOf, GENESIS_PREV } from './log.js';
import { AuditError, EXIT } from './errors.js';

function validateFix(fix) {
  if (fix === null || typeof fix !== 'object' || Array.isArray(fix) || !Array.isArray(fix.patchOps)) {
    throw new AuditError(EXIT.USAGE, 'fix.json must be an object with a "patchOps" array');
  }
  for (const [i, op] of fix.patchOps.entries()) {
    const where = `patchOps[${i}]`;
    if (op === null || typeof op !== 'object') throw new AuditError(EXIT.USAGE, `${where}: op must be an object`);
    if (!Number.isInteger(op.seq) || op.seq < 1) throw new AuditError(EXIT.USAGE, `${where}: seq must be a positive integer`);
    if (op.op === 'replaceBody') {
      if (op.fields === null || typeof op.fields !== 'object' || Array.isArray(op.fields)) {
        throw new AuditError(EXIT.USAGE, `${where}: replaceBody requires object "fields"`);
      }
    } else if (op.op === 'void') {
      if (typeof op.reason !== 'string' || op.reason === '') {
        throw new AuditError(EXIT.USAGE, `${where}: void requires non-empty string "reason"`);
      }
    } else {
      throw new AuditError(EXIT.USAGE, `${where}: unknown op ${JSON.stringify(op.op)} (allowed: replaceBody, void)`);
    }
  }
}

export function complementRanges(changedSeqs, n) {
  const changed = new Set(changedSeqs);
  const ranges = [];
  let start = null;
  for (let s = 1; s <= n; s++) {
    if (!changed.has(s)) {
      if (start === null) start = s;
    } else if (start !== null) {
      ranges.push([start, s - 1]);
      start = null;
    }
  }
  if (start !== null) ranges.push([start, n]);
  return ranges;
}

export function applyFix(events, fix) {
  validateFix(fix);
  const n = events.length;
  const opBySeq = new Map();
  for (const op of fix.patchOps) {
    if (op.seq > n) throw new AuditError(EXIT.USAGE, `patchOps: seq ${op.seq} out of range (log has ${n} events)`);
    if (opBySeq.has(op.seq)) throw new AuditError(EXIT.USAGE, `patchOps: duplicate op for seq ${op.seq}`);
    opBySeq.set(op.seq, op);
  }
  const changedSeqs = [...opBySeq.keys()].sort((a, b) => a - b);

  const newEvents = events.map((ev) => ({ seq: ev.seq, prevHash: ev.prevHash, hash: ev.hash, body: ev.body }));
  for (const seq of changedSeqs) {
    const op = opBySeq.get(seq);
    const ev = newEvents[seq - 1];
    ev.body = op.op === 'replaceBody'
      ? { ...ev.body, ...op.fields }
      : { voided: true, reason: op.reason };
  }
  const firstChanged = changedSeqs.length ? changedSeqs[0] : n + 1;
  for (let i = firstChanged - 1; i < n; i++) {
    newEvents[i].prevHash = i === 0 ? GENESIS_PREV : newEvents[i - 1].hash;
    newEvents[i].hash = hashEvent(newEvents[i].prevHash, newEvents[i].body);
  }

  const changes = changedSeqs.map((seq) => {
    const op = opBySeq.get(seq);
    const entry = { seq, op: op.op, beforeHash: events[seq - 1].hash, afterHash: newEvents[seq - 1].hash };
    if (op.op === 'void') entry.reason = op.reason;
    else entry.fields = op.fields;
    return entry;
  });

  const cert = {
    version: 1,
    oldRoot: rootOf(events),
    newRoot: rootOf(newEvents),
    changedSeqs,
    unchangedRanges: complementRanges(changedSeqs, n),
    changes,
  };
  return { newEvents, cert };
}

function writeFileSyncFsync(path, data) {
  const fd = openSync(path, 'w');
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDirBestEffort(path) {
  try {
    const fd = openSync(path, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch { /* best effort */ }
}

// Crash protocol: write both .tmp files, fsync, then rename out first, cert second.
// Any crash leaves a state recoverable by src/recover.js (old / new / partial).
export function atomicWritePair(outPath, outText, certPath, certText) {
  const outTmp = outPath + '.tmp';
  const certTmp = certPath + '.tmp';
  writeFileSyncFsync(outTmp, outText);
  writeFileSyncFsync(certTmp, certText);
  renameSync(outTmp, outPath);
  renameSync(certTmp, certPath);
  fsyncDirBestEffort(dirname(outPath));
  fsyncDirBestEffort(dirname(certPath));
}
