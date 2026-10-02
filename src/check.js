'use strict';

const { canonical } = require('./canonical');
const { rootOf } = require('./chain');
const { AuditError } = require('./errors');
const { computeUnchangedRanges } = require('./patch');

function rangesEqual(a, b) {
  if (!Array.isArray(a) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!Array.isArray(a[i]) || a[i][0] !== b[i][0] || a[i][1] !== b[i][1]) return false;
  }
  return true;
}

// Cross-checks old log, new log and certificate. Both logs must already have
// passed verifyEvents. Throws AuditError locating the first offending seq.
function checkLogs(oldEvents, newEvents, cert) {
  if (oldEvents.length !== newEvents.length) {
    throw new AuditError(
      `event count differs: old=${oldEvents.length} new=${newEvents.length} (seq set changed)`,
      10
    );
  }
  for (let i = 0; i < oldEvents.length; i++) {
    if (oldEvents[i].seq !== newEvents[i].seq) {
      throw new AuditError(
        `seq mismatch at position ${i}: old seq ${oldEvents[i].seq} vs new seq ${newEvents[i].seq}`,
        10,
        newEvents[i].seq
      );
    }
  }

  if (typeof cert !== 'object' || cert === null || Array.isArray(cert)) {
    throw new AuditError('certificate must be a JSON object', 11);
  }
  if (!Array.isArray(cert.changedSeqs) || !cert.changedSeqs.every(Number.isInteger)) {
    throw new AuditError('cert changedSeqs must be an array of integers', 11);
  }
  const changedSeqs = [...cert.changedSeqs].sort((a, b) => a - b);
  for (let i = 0; i < changedSeqs.length; i++) {
    if (changedSeqs[i] !== cert.changedSeqs[i] || (i > 0 && changedSeqs[i] === changedSeqs[i - 1])) {
      throw new AuditError('cert changedSeqs must be sorted and unique', 11);
    }
  }

  const firstSeq = oldEvents.length === 0 ? 1 : oldEvents[0].seq;
  const lastSeq = oldEvents.length === 0 ? 0 : oldEvents[oldEvents.length - 1].seq;
  const expectedRanges = computeUnchangedRanges(firstSeq, lastSeq, changedSeqs);
  if (!rangesEqual(cert.unchangedRanges, expectedRanges)) {
    throw new AuditError(
      `cert unchangedRanges ${JSON.stringify(cert.unchangedRanges)} != expected ${JSON.stringify(expectedRanges)}`,
      11
    );
  }

  if (!Array.isArray(cert.changes)) {
    throw new AuditError('cert changes must be an array', 11);
  }
  const changesBySeq = new Map();
  for (const entry of cert.changes) {
    if (typeof entry !== 'object' || entry === null || !Number.isInteger(entry.seq)) {
      throw new AuditError('cert changes entries must have an integer seq', 11);
    }
    changesBySeq.set(entry.seq, entry);
  }
  const changedSet = new Set(changedSeqs);
  if (changesBySeq.size !== changedSet.size || ![...changedSet].every((s) => changesBySeq.has(s))) {
    throw new AuditError('cert changes do not match cert changedSeqs', 11);
  }

  for (let i = 0; i < oldEvents.length; i++) {
    const seq = oldEvents[i].seq;
    if (changedSet.has(seq)) {
      const entry = changesBySeq.get(seq);
      if (entry.before !== oldEvents[i].hash || entry.after !== newEvents[i].hash) {
        throw new AuditError(`cert change record mismatch at seq ${seq}`, 11, seq);
      }
    } else if (canonical(oldEvents[i].body) !== canonical(newEvents[i].body)) {
      throw new AuditError(`event at seq ${seq} modified but not listed in cert changedSeqs`, 11, seq);
    }
  }

  const oldRoot = rootOf(oldEvents);
  const newRoot = rootOf(newEvents);
  if (cert.oldRoot !== oldRoot) {
    throw new AuditError('cert oldRoot does not match old log root', 11);
  }
  if (cert.newRoot !== newRoot) {
    throw new AuditError('cert newRoot does not match new log root', 11);
  }
  return { oldRoot, newRoot, changedSeqs };
}

module.exports = { checkLogs };
