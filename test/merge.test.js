'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { generate, toNdjson } = require('../gen');
const { mergeTexts } = require('../sync');
const { tmpdir, runCli } = require('./helpers');

// Acceptance 1: fixed seed, two 200-event sources, swapped merge order
// must produce identical result hashes (library level).
test('merge is order-independent (library, seed 17, 200 events per node)', () => {
  const { a, b } = generate(17, 200);
  assert.equal(a.length, 200);
  assert.equal(b.length, 200);
  const ab = mergeTexts(toNdjson(a), toNdjson(b));
  const ba = mergeTexts(toNdjson(b), toNdjson(a));
  assert.equal(ab.hash, ba.hash);
  assert.equal(ab.balance, ba.balance);
  assert.deepEqual(ab.conflicts, ba.conflicts);
  assert.deepEqual(ab.effective, ba.effective);
  assert.equal(ab.logText, ba.logText);
  assert.equal(ab.log.length, 400);
});

// Acceptance 1 (CLI level): merged output files are byte-identical.
test('merge is order-independent (cli output files)', () => {
  const dir = tmpdir('merge');
  const { a, b } = generate(17, 200);
  fs.writeFileSync(path.join(dir, 'a.ndjson'), toNdjson(a));
  fs.writeFileSync(path.join(dir, 'b.ndjson'), toNdjson(b));

  const r1 = runCli(['merge', path.join(dir, 'a.ndjson'), path.join(dir, 'b.ndjson'), '--out', path.join(dir, 'out1')]);
  const r2 = runCli(['merge', path.join(dir, 'b.ndjson'), path.join(dir, 'a.ndjson'), '--out', path.join(dir, 'out2')]);
  assert.equal(r1.status, 0, r1.stderr);
  assert.equal(r2.status, 0, r2.stderr);

  for (const f of ['log.ndjson', 'balance.json', 'conflict.json']) {
    assert.equal(
      fs.readFileSync(path.join(dir, 'out1', f), 'utf8'),
      fs.readFileSync(path.join(dir, 'out2', f), 'utf8'),
      `${f} differs between merge orders`
    );
  }
  const s1 = JSON.parse(r1.stdout);
  const s2 = JSON.parse(r2.stdout);
  assert.equal(s1.hash, s2.hash);
});

// Re-running a completed merge must not change anything (idempotence).
test('re-running merge on a completed out dir is a no-op', () => {
  const dir = tmpdir('idem');
  const { a, b } = generate(7, 50);
  fs.writeFileSync(path.join(dir, 'a.ndjson'), toNdjson(a));
  fs.writeFileSync(path.join(dir, 'b.ndjson'), toNdjson(b));
  const out = path.join(dir, 'out');
  const r1 = runCli(['merge', path.join(dir, 'a.ndjson'), path.join(dir, 'b.ndjson'), '--out', out]);
  assert.equal(r1.status, 0, r1.stderr);
  const before = fs.readFileSync(path.join(out, 'conflict.json'), 'utf8');
  const r2 = runCli(['merge', path.join(dir, 'a.ndjson'), path.join(dir, 'b.ndjson'), '--out', out]);
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(fs.readFileSync(path.join(out, 'conflict.json'), 'utf8'), before);
});

// void only revokes causally visible posts; revive undoes a void explicitly.
test('void visibility and revive semantics', () => {
  const post = { id: 'tx1', kind: 'post', causes: [], lamport: 1, node: 'A', amount: 100 };
  const voidTx = { id: 'v1', kind: 'void', causes: ['tx1'], lamport: 2, node: 'A', target: 'tx1' };
  const revive = { id: 'r1', kind: 'revive', causes: ['v1'], lamport: 3, node: 'A', target: 'v1' };
  // concurrent void (does not cause-follow the post) must NOT revoke it
  const concurrentVoid = { id: 'v2', kind: 'void', causes: [], lamport: 1, node: 'B', target: 'tx1' };

  assert.equal(mergeTexts(toNdjson([post]), toNdjson([])).balance, 100);
  assert.equal(mergeTexts(toNdjson([post, voidTx]), toNdjson([])).balance, 0);
  assert.equal(mergeTexts(toNdjson([post, voidTx, revive]), toNdjson([])).balance, 100);
  assert.equal(mergeTexts(toNdjson([post]), toNdjson([concurrentVoid])).balance, 100);
});
