'use strict';

const crypto = require('crypto');
const { canonical } = require('./canonical');
const { AuditError } = require('./errors');

const GENESIS = '0'.repeat(64);

function sha256hex(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

function computeHash(prevHash, body) {
  return sha256hex(prevHash + canonical(body));
}

function parseLog(text) {
  const events = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      throw new AuditError(`line ${i + 1}: invalid JSON`, 9);
    }
    if (typeof ev !== 'object' || ev === null || Array.isArray(ev)) {
      throw new AuditError(`line ${i + 1}: event must be an object`, 9);
    }
    if (!Number.isInteger(ev.seq)) {
      throw new AuditError(`line ${i + 1}: seq must be an integer`, 9);
    }
    if (typeof ev.prevHash !== 'string' || typeof ev.hash !== 'string') {
      throw new AuditError(`line ${i + 1}: prevHash/hash must be strings`, 9, ev.seq);
    }
    if (!('body' in ev)) {
      throw new AuditError(`line ${i + 1}: missing body`, 9, ev.seq);
    }
    events.push({ seq: ev.seq, prevHash: ev.prevHash, hash: ev.hash, body: ev.body });
  }
  return events;
}

// Verifies seq consecutiveness (1..N), chain linkage and hash correctness.
// Returns the root hash (hash of the last event, GENESIS for an empty log).
function verifyEvents(events) {
  let prev = GENESIS;
  let expectedSeq = 1;
  for (const ev of events) {
    if (ev.seq !== expectedSeq) {
      throw new AuditError(`seq discontinuity at seq ${ev.seq}: expected ${expectedSeq}`, 9, ev.seq);
    }
    if (ev.prevHash !== prev) {
      throw new AuditError(`broken chain at seq ${ev.seq}: prevHash does not match previous hash`, 9, ev.seq);
    }
    const recomputed = computeHash(ev.prevHash, ev.body);
    if (recomputed !== ev.hash) {
      throw new AuditError(`hash mismatch at seq ${ev.seq}`, 9, ev.seq);
    }
    prev = ev.hash;
    expectedSeq += 1;
  }
  return prev;
}

function rootOf(events) {
  return events.length === 0 ? GENESIS : events[events.length - 1].hash;
}

function serializeLog(events) {
  return events
    .map((ev) => JSON.stringify({ seq: ev.seq, prevHash: ev.prevHash, hash: ev.hash, body: ev.body }))
    .join('\n') + '\n';
}

module.exports = { GENESIS, sha256hex, computeHash, parseLog, verifyEvents, rootOf, serializeLog };
