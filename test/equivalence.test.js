'use strict';

// Acceptance 1: rewriting a rule set into an equivalent form yields an
// empty distinguishing witness and an unchanged snapshot hash.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { RuleLibrary, distinguishingWitnessForLibs } = require('../src/rulelib');

function libWith(rules) {
  const lib = new RuleLibrary();
  lib.applyLayer(rules.map((r) => ({ type: 'add', ...r })));
  return lib;
}

test('equivalent rewrite: witness is empty and hash is unchanged', () => {
  const a = libWith([
    { id: 'r1', kind: 'red', pattern: 'A(B|C)' },
    { id: 'y1', kind: 'yellow', pattern: 'S+' },
  ]);
  const b = libWith([
    { id: 'r9', kind: 'red', pattern: 'AB|AC' },
    { id: 'y9', kind: 'yellow', pattern: 'SS*' },
  ]);
  assert.equal(distinguishingWitnessForLibs(a, b), null);
  assert.equal(a.snapshotHash(), b.snapshotHash());
});

test('rule id and insertion order do not affect the hash', () => {
  const a = libWith([
    { id: 'x', kind: 'red', pattern: 'AB' },
    { id: 'y', kind: 'yellow', pattern: 'S' },
  ]);
  const b = new RuleLibrary();
  b.applyLayer([{ type: 'add', id: 'p', kind: 'yellow', pattern: 'S' }]);
  b.applyLayer([{ type: 'add', id: 'q', kind: 'red', pattern: 'AB' }]);
  assert.equal(a.snapshotHash(), b.snapshotHash());
  assert.equal(distinguishingWitnessForLibs(a, b), null);
});

test('non-equivalent sets: shortest distinguishing witness is reported', () => {
  const a = libWith([{ id: 'r1', kind: 'red', pattern: 'AB' }]);
  const b = libWith([{ id: 'r1', kind: 'red', pattern: 'ABC' }]);
  // "AB" contains an AB occurrence but no ABC occurrence.
  assert.equal(distinguishingWitnessForLibs(a, b), 'AB');
});

test('witness can come from the yellow layer too', () => {
  const a = libWith([{ id: 'y1', kind: 'yellow', pattern: 'SA' }]);
  const b = libWith([{ id: 'y1', kind: 'yellow', pattern: 'SB' }]);
  const w = distinguishingWitnessForLibs(a, b);
  assert.equal(w.length, 2);
  assert.ok(w === 'SA' || w === 'SB');
});

test('empty libraries are equivalent', () => {
  const a = new RuleLibrary();
  const b = new RuleLibrary();
  assert.equal(distinguishingWitnessForLibs(a, b), null);
  assert.equal(a.snapshotHash(), b.snapshotHash());
});
