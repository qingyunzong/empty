'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpdir, runCli, writeNdjson } = require('./helpers');

// Acceptance 4: concurrent posts with the same id but different amounts,
// imported in both directions, must yield the identical conflict.json and
// leave the balance unchanged (the conflicting transaction contributes 0).
test('concurrent same-id different-amount conflict is deterministic both ways', () => {
  const dir = tmpdir('conflict');
  const a = [
    { id: 'tx-a1', kind: 'post', causes: [], lamport: 1, node: 'A', amount: 500 },
    { id: 'tx-shared', kind: 'post', causes: [], lamport: 2, node: 'A', amount: 100 },
    { id: 'tx-a2', kind: 'post', causes: ['tx-a1'], lamport: 3, node: 'A', amount: 250 },
  ];
  const b = [
    { id: 'tx-b1', kind: 'post', causes: [], lamport: 1, node: 'B', amount: 700 },
    { id: 'tx-shared', kind: 'post', causes: [], lamport: 2, node: 'B', amount: 999 },
  ];
  writeNdjson(path.join(dir, 'a.ndjson'), a);
  writeNdjson(path.join(dir, 'b.ndjson'), b);
  const out1 = path.join(dir, 'out-ab');
  const out2 = path.join(dir, 'out-ba');
  const r1 = runCli(['merge', path.join(dir, 'a.ndjson'), path.join(dir, 'b.ndjson'), '--out', out1]);
  const r2 = runCli(['merge', path.join(dir, 'b.ndjson'), path.join(dir, 'a.ndjson'), '--out', out2]);
  assert.equal(r1.status, 0, r1.stderr);
  assert.equal(r2.status, 0, r2.stderr);
  const c1 = fs.readFileSync(path.join(out1, 'conflict.json'), 'utf8');
  const c2 = fs.readFileSync(path.join(out2, 'conflict.json'), 'utf8');
  assert.equal(c1, c2, 'conflict.json must be identical for both import directions');
  const conflicts = JSON.parse(c1).conflicts;
  assert.deepEqual(conflicts, [
    { id: 'tx-shared', amounts: [100, 999], nodes: ['A', 'B'], concurrent: true },
  ]);
  // Balance excludes the conflicted transaction entirely: 500 + 250 + 700.
  const balance = JSON.parse(fs.readFileSync(path.join(out1, 'balance.json'), 'utf8')).balance;
  assert.equal(balance, 1450);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(out2, 'balance.json'), 'utf8')).balance,
    1450
  );
});

// Identical concurrent duplicates (same id, same amount) are NOT a conflict
// and are credited exactly once.
test('identical concurrent posts dedupe to a single credit', () => {
  const dir = tmpdir('dedupe');
  const post = { id: 'tx1', kind: 'post', causes: [], lamport: 1, node: 'A', amount: 42 };
  const copy = { ...post, node: 'B' };
  writeNdjson(path.join(dir, 'a.ndjson'), [post]);
  writeNdjson(path.join(dir, 'b.ndjson'), [copy]);
  const out = path.join(dir, 'out');
  const r = runCli(['merge', path.join(dir, 'a.ndjson'), path.join(dir, 'b.ndjson'), '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'balance.json'), 'utf8')).balance, 42);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'conflict.json'), 'utf8')).conflicts, []);
});
