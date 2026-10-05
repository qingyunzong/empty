'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { mergePatches } = require('../lib/merge');
const { applyPatch, effectiveAt } = require('../lib/tree');
const { baseTree } = require('./helpers');

test('acceptance 1: parent/child disjoint overrides merge and inherit correctly', () => {
  const left = { set: { '/a': { hum: 25 } } }; // parent override
  const right = { set: { '/a/b': { press: 100 } } }; // child override, disjoint key
  const { patch, conflicts } = mergePatches(left, right);
  assert.deepEqual(conflicts, []);

  const merged = applyPatch(baseTree(), patch);
  // /a/b: temp from /a, hum merged onto /a, press merged onto /a/b
  assert.deepEqual(effectiveAt(merged, ['a', 'b']), { temp: 15, hum: 25, press: 100 });
  // /a itself inherits press from nothing; root keys still flow down
  assert.deepEqual(effectiveAt(merged, ['a']), { temp: 15, hum: 25 });
  // untouched sibling still inherits root defaults
  assert.deepEqual(effectiveAt(merged, ['c']), { temp: 10, hum: 20 });
});

test('acceptance 2: deleting a parent conflicts with modifying its child', () => {
  const left = { delete: ['/a'] };
  const right = { set: { '/a/b': { temp: 99 } } };
  const { patch, conflicts } = mergePatches(left, right);
  assert.equal(patch, null);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].type, 'structural');
  assert.match(conflicts[0].detail, /\/a\/b/);
});

test('same path + same key with different values conflicts', () => {
  const { patch, conflicts } = mergePatches(
    { set: { '/a': { temp: 1 } } },
    { set: { '/a': { temp: 2 } } },
  );
  assert.equal(patch, null);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].type, 'value');
  assert.equal(conflicts[0].key, 'temp');
});

test('identical changes on both sides dedupe; disjoint paths auto-merge', () => {
  const { patch, conflicts } = mergePatches(
    { set: { '/a': { temp: 1 } } },
    { set: { '/a': { temp: 1 }, '/c': { hum: 3 } } },
  );
  assert.deepEqual(conflicts, []);
  assert.deepEqual(patch.set, { '/a': { temp: 1 }, '/c': { hum: 3 } });
});

test('set vs unset on the same key conflicts', () => {
  const { conflicts } = mergePatches(
    { set: { '/a': { temp: 1 } } },
    { unset: { '/a': ['temp'] } },
  );
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].type, 'value');
});

test('delete on both sides and nested deletes merge cleanly', () => {
  const same = mergePatches({ delete: ['/a'] }, { delete: ['/a'] });
  assert.deepEqual(same.conflicts, []);
  assert.deepEqual(same.patch.delete, ['/a']);

  const nested = mergePatches({ delete: ['/a/b'] }, { delete: ['/a'] });
  assert.deepEqual(nested.conflicts, []);
  assert.deepEqual(nested.patch.delete, ['/a']);
});
