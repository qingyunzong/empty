'use strict';

// Equivalence evidence: canonical row hashes, deterministic row samples, and
// full multiset comparison for small inputs (<= 300 rows).
const crypto = require('crypto');
const V = require('./values');

const FULL_CHECK_LIMIT = 300;

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function canonicalRow(row) {
  const keys = Object.keys(row).filter((k) => k !== '__aggs').sort();
  return keys.map((k) => k + '=' + V.encVal(row[k])).join(',');
}

function rowHash(row) {
  return sha256(canonicalRow(row));
}

function multisetHash(rows) {
  return sha256(rows.map(rowHash).sort().join('\n'));
}

// Deterministic sample: sort row hashes, pick up to k evenly spaced entries.
function sampleRowHashes(rows, k = 8) {
  const hs = rows.map(rowHash).sort();
  if (hs.length <= k) return hs;
  const out = [];
  for (let i = 0; i < k; i++) out.push(hs[Math.round((i * (hs.length - 1)) / (k - 1))]);
  return out;
}

function resultsEqual(a, b) {
  return (
    multisetHash(a.rows) === multisetHash(b.rows) &&
    multisetHash(a.unknown) === multisetHash(b.unknown) &&
    a.falseCount === b.falseCount
  );
}

function summarizeResult(res) {
  return {
    rowCount: res.rows.length,
    rowsHash: multisetHash(res.rows),
    rowSamples: sampleRowHashes(res.rows),
    unknownCount: res.unknown.length,
    unknownHash: multisetHash(res.unknown),
    falseCount: res.falseCount,
  };
}

// Build the equivalence certificate for one optimization run. `equal` is a
// full comparison whenever total input rows <= FULL_CHECK_LIMIT (and is also
// computed exactly beyond that, since we are offline on a single machine).
function makeCertificate({ rules, inputRows, baseline, optimized }) {
  const b = summarizeResult(baseline);
  const o = summarizeResult(optimized);
  const equal = resultsEqual(baseline, optimized);
  return {
    rules,
    inputRows,
    mode: inputRows <= FULL_CHECK_LIMIT ? 'full' : 'full+sampled',
    baseline: b,
    optimized: o,
    equal,
  };
}

module.exports = {
  FULL_CHECK_LIMIT,
  rowHash,
  multisetHash,
  sampleRowHashes,
  resultsEqual,
  summarizeResult,
  makeCertificate,
};
