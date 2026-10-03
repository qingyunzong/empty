'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Platform } = require('../src/platform');

function buildLineage() {
  // raw -> clean -> report
  // raw -> audit
  // other (independent branch)
  const p = new Platform({ cpu: 8, mem: 8 });
  p.submit({ id: 'raw', owner: 'alice', bytes: 10 });
  p.submit({ id: 'clean', owner: 'alice', deps: ['raw'], bytes: 6 });
  p.submit({ id: 'report', owner: 'bob', deps: ['clean'], bytes: 2 });
  p.submit({ id: 'audit', owner: 'bob', deps: ['raw'], bytes: 1 });
  p.submit({ id: 'other', owner: 'carol', bytes: 7 });
  p.schedule();
  return p;
}

test('invalidation propagates precisely to the affected subtree only', () => {
  const p = buildLineage();
  assert.equal(p.nodes.get('report').status, 'completed');
  const set = p.invalidate('clean');
  assert.deepEqual(set, ['clean', 'report']);
  assert.equal(p.nodes.get('raw').status, 'completed', 'ancestor untouched');
  assert.equal(p.nodes.get('audit').status, 'completed', 'sibling subtree untouched');
  assert.equal(p.nodes.get('other').status, 'completed', 'independent node untouched');
  // refunded bytes: alice 16 -> 10, bob 3 -> 1
  assert.equal(p.bytesOf('alice'), 10);
  assert.equal(p.bytesOf('bob'), 1);
});

test('acceptance: correcting a parent invalidates only necessary descendants', () => {
  const p = buildLineage();
  const rootBefore = p.stateRoot();
  const set = p.correct('raw', { bytes: 12, duration: 2 });
  assert.deepEqual(set, ['audit', 'clean', 'raw', 'report']);
  assert.equal(p.nodes.get('other').status, 'completed', 'unrelated branch keeps evidence');
  assert.equal(p.bytesOf('carol'), 7, 'unrelated owner quota untouched');
  assert.equal(p.bytesOf('alice'), 0, 'invalidated bytes refunded');
  assert.notEqual(p.stateRoot(), rootBefore);
  // recomputation restores the derived chain with the corrected spec
  const { completed } = p.schedule();
  assert.deepEqual(completed, ['audit', 'clean', 'other', 'raw', 'report']);
  assert.equal(p.bytesOf('alice'), 18); // 12 + 6
});

test('correction of a leaf invalidates only the leaf itself', () => {
  const p = buildLineage();
  const set = p.correct('report', { bytes: 3 });
  assert.deepEqual(set, ['report']);
  assert.equal(p.nodes.get('clean').status, 'completed');
});

test('correct rejects cycles and oversize resources without mutating state', () => {
  const p = buildLineage();
  const rootBefore = p.stateRoot();
  assert.throws(() => p.correct('raw', { deps: ['report'] }), /cycle/i);
  assert.throws(() => p.correct('raw', { cpu: 99 }), /machine/i);
  assert.equal(p.stateRoot(), rootBefore, 'failed correction leaves state untouched');
});
