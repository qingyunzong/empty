'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makePair, keyOf, writeCsv, existsCsv, csvContent, dirHash, callCliJson, syncDirs } = require('./helpers');
const { loadState } = require('../lib/state');
const { fileNameForKey } = require('../lib/keys');

// 200 keys: 120 shared baseline, 40 new in A, 40 new in B.
// Mutations after baseline sync: 30 modified in A, 30 modified in B,
// 20 deleted in A, 20 deleted in B.
function buildScenario(t) {
  const { a, b } = makePair(t);
  const keys = [];
  for (let i = 0; i < 200; i++) keys.push(keyOf(i));
  const shared = keys.slice(0, 120);
  const onlyA = keys.slice(120, 160);
  const onlyB = keys.slice(160, 200);

  for (const [i, k] of shared.entries()) {
    writeCsv(a, k, csvContent('base', i));
    writeCsv(b, k, csvContent('base', i));
  }
  // Baseline sync to establish state (hashes + mtime vector).
  callCliJson(['apply', '--a', a, '--b', b]);

  const modA = shared.slice(0, 30);
  const modB = shared.slice(30, 60);
  const delA = shared.slice(60, 80);
  const delB = shared.slice(80, 100);

  for (const [i, k] of modA.entries()) writeCsv(a, k, csvContent('modA', i));
  for (const [i, k] of modB.entries()) writeCsv(b, k, csvContent('modB', i));
  for (const k of delA) fs.unlinkSync(path.join(a, fileNameForKey(k)));
  for (const k of delB) fs.unlinkSync(path.join(b, fileNameForKey(k)));
  for (const [i, k] of onlyA.entries()) writeCsv(a, k, csvContent('newA', i));
  for (const [i, k] of onlyB.entries()) writeCsv(b, k, csvContent('newB', i));

  return { a, b, modA, modB, delA, delB, onlyA, onlyB };
}

test('200 files with mods+deletes: A->B and B->A converge to identical hash', (t) => {
  const s = buildScenario(t);

  const diff = callCliJson(['diff', '--a', s.a, '--b', s.b]).json;
  assert.equal(diff.conflicts.length, 0);
  assert.equal(diff.errors.length, 0);
  const copies = diff.changes.filter((c) => c.op === 'copy');
  const deletes = diff.changes.filter((c) => c.op === 'delete');
  // copies: 30 modA + 30 modB + 40 newA + 40 newB = 140; deletes: 20 + 20 = 40
  assert.equal(copies.length, 140);
  assert.equal(deletes.length, 40);

  const { plan, stats } = syncDirs(s.a, s.b);
  assert.equal(plan.ops.length, 180);
  assert.equal(stats.copied, 140);
  assert.equal(stats.deleted, 40);

  const hashA = dirHash(s.a);
  const hashB = dirHash(s.b);
  assert.equal(hashA, hashB, 'A and B must converge to identical content hash');

  // Deletes propagated: tombstones recorded on both sides.
  const stateA = loadState(s.a);
  const stateB = loadState(s.b);
  for (const k of [...s.delA, ...s.delB]) {
    assert.equal(existsCsv(s.a, k), false);
    assert.equal(existsCsv(s.b, k), false);
    assert.equal(stateA.files[k].deleted, true);
    assert.equal(stateB.files[k].deleted, true);
  }
  // Final file count: 120 - 40 deleted + 80 new = 160 per side.
  assert.equal(fs.readdirSync(s.a).filter((f) => f.endsWith('.csv')).length, 160);
  assert.equal(fs.readdirSync(s.b).filter((f) => f.endsWith('.csv')).length, 160);

  // Idempotent: second round is a no-op.
  const diff2 = callCliJson(['diff', '--a', s.a, '--b', s.b]).json;
  assert.equal(diff2.changes.length, 0);
  const stats2 = callCliJson(['apply', '--a', s.a, '--b', s.b]).json;
  assert.equal(stats2.copied, 0);
  assert.equal(stats2.deleted, 0);
});

test('mirrored scenario (roles swapped) converges to the same final hash', (t) => {
  const s1 = buildScenario(t);
  syncDirs(s1.a, s1.b);

  const s2 = buildScenario(t);
  syncDirs(s2.b, s2.a); // opposite argument order

  assert.equal(dirHash(s1.a), dirHash(s2.a));
  assert.equal(dirHash(s1.b), dirHash(s2.b));
});
