'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makePair, writeCsv, readCsv, existsCsv, csvContent, callCli, callCliJson, syncDirs, dirHash } = require('./helpers');
const { sha256 } = require('../lib/hash');

const KEY = 'm001|2026-09-15|USD';
const CONTENT_X = 'h\nx-version\n';
const CONTENT_Y = 'h\ny-version\n';

function conflictPair(t) {
  const { a, b } = makePair(t);
  writeCsv(a, KEY, CONTENT_X);
  writeCsv(b, KEY, CONTENT_Y);
  return { a, b };
}

function readCert(dir, certHash) {
  const p = path.join(dir, '.sync', 'conflicts', `${certHash}.json`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

test('same-key conflict: no silent winner, identical certificate both directions, content kept in both copies', (t) => {
  const s = conflictPair(t);

  // diff reports the conflict with its source explanation.
  const diff = callCliJson(['diff', '--a', s.a, '--b', s.b]).json;
  assert.equal(diff.conflicts.length, 1);
  assert.equal(diff.conflicts[0].reason, 'no-common-ancestor');
  assert.equal(diff.conflicts[0].key, KEY);

  // plan contains zero ops for the conflicted key: directory order must not win silently.
  const { plan, stats } = syncDirs(s.a, s.b);
  assert.equal(plan.ops.filter((o) => o.key === KEY).length, 0);
  assert.equal(stats.copied, 0);
  assert.equal(readCsv(s.a, KEY), CONTENT_X);
  assert.equal(readCsv(s.b, KEY), CONTENT_Y);

  // Resolve on the first pair, winner = A's content.
  const r1 = callCliJson(['resolve', '--a', s.a, '--b', s.b, '--key', KEY, '--winner', 'a']).json;
  assert.equal(r1.cert.winnerHash, sha256(CONTENT_X));

  // Identical certificate file in both dirs.
  const certA = readCert(s.a, r1.cert.certHash);
  const certB = readCert(s.b, r1.cert.certHash);
  assert.deepEqual(certA, certB);

  // Content kept in both copies: canonical = winner, loser preserved as sidecar, in BOTH dirs.
  for (const dir of [s.a, s.b]) {
    assert.equal(readCsv(dir, KEY), CONTENT_X);
    const sidecar = path.join(dir, r1.loserName);
    assert.equal(fs.readFileSync(sidecar, 'utf8'), CONTENT_Y);
  }
  assert.equal(dirHash(s.a), dirHash(s.b));

  // Second pair with roles swapped (A holds Y, B holds X); resolve with winner = B's content (= X).
  const s2 = conflictPair(t);
  // swap contents so the "winner content" comes from the opposite CLI side
  writeCsv(s2.a, KEY, CONTENT_Y);
  writeCsv(s2.b, KEY, CONTENT_X);
  const r2 = callCliJson(['resolve', '--a', s2.a, '--b', s2.b, '--key', KEY, '--winner', 'b']).json;

  // The conflict certificate is identical regardless of direction.
  assert.equal(r2.cert.certHash, r1.cert.certHash);
  assert.deepEqual(r2.cert, r1.cert);
});

test('both-modified conflict is detected against common ancestor', (t) => {
  const { a, b } = makePair(t);
  writeCsv(a, KEY, csvContent('v0', 1));
  writeCsv(b, KEY, csvContent('v0', 1));
  callCliJson(['apply', '--a', a, '--b', b]); // establish ancestor state
  writeCsv(a, KEY, csvContent('vA', 1));
  writeCsv(b, KEY, csvContent('vB', 1));
  const diff = callCliJson(['diff', '--a', a, '--b', b]).json;
  assert.equal(diff.conflicts.length, 1);
  assert.equal(diff.conflicts[0].reason, 'both-modified');
  // plan must not include the conflicted key
  const plan = callCliJson(['plan', '--a', a, '--b', b]).json;
  assert.equal(plan.ops.filter((o) => o.key === KEY).length, 0);
});
