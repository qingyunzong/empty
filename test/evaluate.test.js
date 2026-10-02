'use strict';

// Acceptance 2: a red hit takes priority over yellow, and the witness is
// the shortest counterexample (shortest plan substring matching a red rule).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { RuleLibrary } = require('../src/rulelib');

function libWith(rules) {
  const lib = new RuleLibrary();
  lib.applyLayer(rules.map((r) => ({ type: 'add', ...r })));
  return lib;
}

test('red hit wins over yellow and yields the shortest counterexample', () => {
  const lib = libWith([
    { id: 'red1', kind: 'red', pattern: 'AB' },
    { id: 'y1', kind: 'yellow', pattern: 'A' },
  ]);
  const r = lib.evaluate('AB');
  assert.equal(r.status, 'rejected');
  assert.deepEqual(r.matchedRuleIds, ['red1', 'y1']);
  assert.equal(r.witness, 'AB');
  assert.match(r.snapshotHash, /^[0-9a-f]{64}$/);
});

test('witness is the shortest red window, not the whole plan', () => {
  const lib = libWith([{ id: 'red1', kind: 'red', pattern: 'ABA' }]);
  const r = lib.evaluate('BABAB');
  assert.equal(r.status, 'rejected');
  assert.equal(r.witness, 'ABA');
});

test('shortest window across multiple red rules', () => {
  const lib = libWith([
    { id: 'r1', kind: 'red', pattern: 'SABS' },
    { id: 'r2', kind: 'red', pattern: 'BS' },
  ]);
  const r = lib.evaluate('SABS');
  assert.equal(r.status, 'rejected');
  assert.deepEqual(r.matchedRuleIds, ['r1', 'r2']);
  assert.equal(r.witness, 'BS');
});

test('yellow-only hit requires confirmation with empty witness', () => {
  const lib = libWith([
    { id: 'red1', kind: 'red', pattern: 'FF' },
    { id: 'y1', kind: 'yellow', pattern: 'A(B|C)' },
  ]);
  const r = lib.evaluate('SAC');
  assert.equal(r.status, 'needs-confirmation');
  assert.deepEqual(r.matchedRuleIds, ['y1']);
  assert.equal(r.witness, null);
});

test('clean plan is feasible', () => {
  const lib = libWith([
    { id: 'red1', kind: 'red', pattern: 'FF' },
    { id: 'y1', kind: 'yellow', pattern: 'S+' },
  ]);
  const r = lib.evaluate('ABC');
  assert.equal(r.status, 'feasible');
  assert.deepEqual(r.matchedRuleIds, []);
  assert.equal(r.witness, null);
});

test('epsilon red rule rejects even the empty plan with empty witness', () => {
  const lib = libWith([{ id: 'r0', kind: 'red', pattern: '()' }]);
  const r = lib.evaluate('');
  assert.equal(r.status, 'rejected');
  assert.equal(r.witness, '');
});

test('empty alphabet: no rules, empty plan is feasible', () => {
  const lib = new RuleLibrary();
  const r = lib.evaluate('');
  assert.equal(r.status, 'feasible');
  assert.deepEqual(r.matchedRuleIds, []);
  assert.equal(r.witness, null);
});

test('plan symbols outside the rule alphabet cannot be matched across', () => {
  const lib = libWith([{ id: 'r1', kind: 'red', pattern: 'AB' }]);
  assert.equal(lib.evaluate('AXB').status, 'feasible');
  assert.equal(lib.evaluate('XAB').status, 'rejected');
});
