'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tmpdirPath, writeJson, readJson, runCli } = require('./helpers');

const base = {
  accounts: {
    a1: { limit: 150, used: 20, holds: [{ hid: 'h1', amount: 10, tag: 'fraud' }] },
    a2: { limit: 100, used: 0, holds: [] },
  },
};

const target = {
  accounts: {
    a1: { limit: 200, used: 20, holds: [{ hid: 'h1', amount: 10, tag: 'review' }, { hid: 'h2', amount: 30, tag: 'legal' }] },
    a2: { limit: 100, used: 0, holds: [] },
  },
};

test('diff emits only the four structured op types', () => {
  const dir = tmpdirPath();
  const b = writeJson(dir, 'base.json', base);
  const t = writeJson(dir, 'target.json', target);
  const p = require('node:path').join(dir, 'patch.json');
  const res = runCli(['diff', b, t, '--out', p]);
  assert.equal(res.code, 0);
  const patch = readJson(p);
  assert.ok(patch.fromHash && patch.toHash && patch.sha256);
  assert.ok(Array.isArray(patch.ops) && patch.ops.length === 3);
  for (const op of patch.ops) {
    assert.ok(['setLimit', 'addHold', 'removeHold', 'changeTag'].includes(op.op));
  }
});

test('apply adds/releases holds and sets limit; available = limit-used-sum(holds)', () => {
  const dir = tmpdirPath();
  const b = writeJson(dir, 'base.json', base);
  const t = writeJson(dir, 'target.json', target);
  const p = require('node:path').join(dir, 'patch.json');
  assert.equal(runCli(['diff', b, t, '--out', p]).code, 0);

  const res = runCli(['apply', b, p]);
  assert.equal(res.code, 0);
  assert.equal(res.stdout[0].status, 'applied');
  const after = readJson(b);
  assert.deepEqual(after, target);
  const acc = after.accounts.a1;
  const available = acc.limit - acc.used - acc.holds.reduce((s, h) => s + h.amount, 0);
  assert.equal(available, 200 - 20 - 40);

  // release the hold again via revert (removeHold path)
  const rev = runCli(['revert', b, p]);
  assert.equal(rev.code, 0);
  assert.equal(rev.stdout[0].status, 'reverted');
  assert.deepEqual(readJson(b), base);
});

test('apply --dry-run validates without writing', () => {
  const dir = tmpdirPath();
  const b = writeJson(dir, 'base.json', base);
  const t = writeJson(dir, 'target.json', target);
  const p = require('node:path').join(dir, 'patch.json');
  runCli(['diff', b, t, '--out', p]);
  const res = runCli(['apply', b, p, '--dry-run']);
  assert.equal(res.code, 0);
  assert.equal(res.stdout[0].status, 'dry-run');
  assert.deepEqual(readJson(b), base);
});
