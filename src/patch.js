'use strict';

const fs = require('fs');
const { GENESIS, computeHash } = require('./chain');
const { AuditError } = require('./errors');

const ALLOWED_KEYS = {
  replaceBody: new Set(['op', 'seq', 'fields']),
  void: new Set(['op', 'seq', 'reason']),
};

function validateOps(ops) {
  if (!Array.isArray(ops)) {
    throw new AuditError('fix.json must contain a "patchOps" array', 1);
  }
  const seen = new Set();
  for (const op of ops) {
    if (typeof op !== 'object' || op === null || Array.isArray(op)) {
      throw new AuditError('each patch op must be an object', 1);
    }
    // seq may appear only as a locator; prevHash/hash must never be patched.
    for (const forbidden of ['prevHash', 'hash']) {
      if (forbidden in op) {
        throw new AuditError(`forbidden field "${forbidden}" in patch op (seq ${op.seq})`, 10, op.seq);
      }
    }
    if (op.op !== 'replaceBody' && op.op !== 'void') {
      throw new AuditError(`unknown patch op "${op.op}"`, 1);
    }
    if (!Number.isInteger(op.seq)) {
      throw new AuditError('patch op requires an integer seq', 1);
    }
    if (op.op === 'replaceBody') {
      if (typeof op.fields !== 'object' || op.fields === null || Array.isArray(op.fields)) {
        throw new AuditError(`replaceBody(seq ${op.seq}) requires an object "fields"`, 1, op.seq);
      }
    } else if (typeof op.reason !== 'string') {
      throw new AuditError(`void(seq ${op.seq}) requires a string "reason"`, 1, op.seq);
    }
    for (const key of Object.keys(op)) {
      if (!ALLOWED_KEYS[op.op].has(key)) {
        throw new AuditError(`unexpected field "${key}" in ${op.op} op (seq ${op.seq})`, 1, op.seq);
      }
    }
    if (seen.has(op.seq)) {
      throw new AuditError(`duplicate patch op for seq ${op.seq}`, 1, op.seq);
    }
    seen.add(op.seq);
  }
}

// Applies validated ops to verified events and re-computes the hash chain.
// seq values and ordering are never modified; void keeps a tombstone event.
function applyOps(oldEvents, ops) {
  const bySeq = new Map(oldEvents.map((ev) => [ev.seq, ev]));
  const opBySeq = new Map(ops.map((op) => [op.seq, op]));
  for (const op of ops) {
    if (!bySeq.has(op.seq)) {
      throw new AuditError(`patch op targets missing seq ${op.seq}`, 1, op.seq);
    }
  }
  const newEvents = oldEvents.map((ev) => {
    const op = opBySeq.get(ev.seq);
    let body = ev.body;
    if (op) {
      if (op.op === 'replaceBody') {
        const base =
          typeof ev.body === 'object' && ev.body !== null && !Array.isArray(ev.body) ? ev.body : {};
        body = { ...base, ...op.fields };
      } else {
        body = { tombstone: true, reason: op.reason, voidedHash: ev.hash };
      }
    }
    return { seq: ev.seq, prevHash: ev.prevHash, hash: ev.hash, body };
  });
  let prev = GENESIS;
  for (const ev of newEvents) {
    ev.prevHash = prev;
    ev.hash = computeHash(prev, ev.body);
    prev = ev.hash;
  }
  const changes = newEvents
    .filter((ev) => opBySeq.has(ev.seq))
    .map((ev) => ({ seq: ev.seq, before: bySeq.get(ev.seq).hash, after: ev.hash }));
  return { newEvents, changedSeqs: changes.map((c) => c.seq), changes };
}

function computeUnchangedRanges(firstSeq, lastSeq, changedSeqs) {
  const changed = new Set(changedSeqs);
  const ranges = [];
  let start = null;
  for (let s = firstSeq; s <= lastSeq; s++) {
    if (!changed.has(s)) {
      if (start === null) start = s;
    } else if (start !== null) {
      ranges.push([start, s - 1]);
      start = null;
    }
  }
  if (start !== null) ranges.push([start, lastSeq]);
  return ranges;
}

function buildCert(oldEvents, oldRoot, result) {
  const firstSeq = oldEvents.length === 0 ? 1 : oldEvents[0].seq;
  const lastSeq = oldEvents.length === 0 ? 0 : oldEvents[oldEvents.length - 1].seq;
  return {
    version: 1,
    oldRoot,
    newRoot: result.newEvents.length === 0 ? GENESIS : result.newEvents[result.newEvents.length - 1].hash,
    changedSeqs: result.changedSeqs,
    unchangedRanges: computeUnchangedRanges(firstSeq, lastSeq, result.changedSeqs),
    changes: result.changes,
  };
}

function writeFileAtomicTmp(path, content) {
  const fd = fs.openSync(path, 'w');
  try {
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// Fault-injection hook for crash-recovery tests: AUDIT_CRASH_AFTER=<point>
// simulates a hard crash after the named persistence step.
function crashPoint(name) {
  if (process.env.AUDIT_CRASH_AFTER === name) {
    process.exit(75);
  }
}

// Persistence order with a single commit point:
//   1. write <out>.tmp        (crash -> old version still authoritative)
//   2. write <cert>.tmp       (crash -> old version still authoritative)
//   3. rename <out>.tmp -> <out>   (crash -> mixed state, recover reports ROLLBACK)
//   4. rename <cert>.tmp -> <cert> (commit: new version authoritative)
function persistPatch(outPath, outText, certPath, certText) {
  writeFileAtomicTmp(outPath + '.tmp', outText);
  crashPoint('new-tmp');
  writeFileAtomicTmp(certPath + '.tmp', certText);
  crashPoint('cert-tmp');
  fs.renameSync(outPath + '.tmp', outPath);
  crashPoint('rename-new');
  fs.renameSync(certPath + '.tmp', certPath);
}

module.exports = { validateOps, applyOps, computeUnchangedRanges, buildCert, persistPatch };
