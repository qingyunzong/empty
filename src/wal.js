'use strict';
const crypto = require('crypto');

// A WAL segment is newline-delimited JSON. Each record carries a checksum
// over its canonical payload so corrupted lines can be detected and skipped.

function payloadOf(rec) {
  return JSON.stringify({
    id: rec.id,
    node: rec.node,
    seq: rec.seq,
    clock: rec.clock,
    reads: rec.reads,
    writes: rec.writes,
  });
}

function checksum(rec) {
  return crypto.createHash('sha256').update(payloadOf(rec)).digest('hex').slice(0, 16);
}

function encodeRecord(rec) {
  return JSON.stringify({ ...rec, cksum: checksum(rec) });
}

// Returns {records, errors}; corrupt lines are skipped, never fatal.
function decodeSegment(text) {
  const records = [];
  const errors = [];
  const lines = String(text).split('\n');
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let rec;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      errors.push({ line: i + 1, reason: 'invalid-json' });
      return;
    }
    const valid =
      rec &&
      typeof rec.id === 'string' &&
      typeof rec.node === 'string' &&
      typeof rec.seq === 'number' &&
      typeof rec.clock === 'object' && rec.clock !== null &&
      typeof rec.reads === 'object' && rec.reads !== null &&
      typeof rec.writes === 'object' && rec.writes !== null &&
      checksum(rec) === rec.cksum;
    if (!valid) {
      errors.push({ line: i + 1, reason: 'bad-record' });
      return;
    }
    delete rec.cksum;
    records.push(rec);
  });
  return { records, errors };
}

module.exports = { encodeRecord, decodeSegment, checksum };
