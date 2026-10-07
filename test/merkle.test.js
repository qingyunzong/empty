'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { merkleRoot } = require('../lib/merkle');

const h = (s) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest();
const hex = (b) => b.toString('hex');

test('single leaf root is the leaf hash', () => {
  assert.equal(merkleRoot(['T1']), hex(h('T1')));
});

test('two leaves combine pairwise', () => {
  const expect = createHash('sha256').update(Buffer.concat([h('T1'), h('C2')])).digest('hex');
  assert.equal(merkleRoot(['T1', 'C2']), expect);
});

test('odd leaf is promoted unchanged', () => {
  const pair = createHash('sha256').update(Buffer.concat([h('T1'), h('C2')])).digest();
  const expect = createHash('sha256').update(Buffer.concat([pair, h('C5')])).digest('hex');
  assert.equal(merkleRoot(['T1', 'C2', 'C5']), expect);
});

test('empty input throws', () => {
  assert.throws(() => merkleRoot([]));
});
