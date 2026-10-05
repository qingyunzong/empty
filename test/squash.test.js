'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { squash, computeStates } = require('../lib/repo');
const { leafEffectiveThresholds } = require('../lib/tree');
const { makeRepo } = require('./helpers');

test('acceptance 3: squash keeps effective config, root hash and old->new mapping', () => {
  const repo = makeRepo();
  const oldStates = computeStates(repo);
  const oldFinal = oldStates.get('d');

  const { repo: out, squashedHash } = squash(repo, 'g', 'c');

  // old -> new commit mapping
  assert.deepEqual(out.mapping, {
    g: 'g',
    a: squashedHash,
    b: squashedHash,
    c: squashedHash,
    d: 'd',
  });
  assert.deepEqual(out.commits.map((c) => c.hash), ['g', squashedHash, 'd']);
  // successor commit re-parented onto the squashed commit
  assert.deepEqual(out.commits[2].parents, [squashedHash]);
  assert.deepEqual(out.commits[1].parents, ['g']);
  assert.equal(out.head, 'd');

  const newStates = computeStates(out);
  // squashed commit reproduces the old state at `c` exactly (same stateHash)
  assert.equal(newStates.get(squashedHash).stateHash, oldStates.get('c').stateHash);
  // root/final stateHash identical before and after
  assert.equal(newStates.get('d').stateHash, oldFinal.stateHash);
  // every leaf's effective thresholds identical
  assert.deepEqual(
    leafEffectiveThresholds(newStates.get('d').tree),
    leafEffectiveThresholds(oldFinal.tree),
  );
  // spot-check the actual effective values at the leaves
  assert.deepEqual(leafEffectiveThresholds(newStates.get('d').tree), {
    '/a/b': { temp: 10, hum: 30, press: 101 },
    '/c': { temp: 5, hum: 21 },
  });
  // stateHash stored on every output commit matches recomputation
  for (const commit of out.commits) {
    assert.equal(commit.stateHash, newStates.get(commit.hash).stateHash);
  }
});

test('squashed patch is a single structured patch equivalent to the range', () => {
  const { repo: out } = squash(makeRepo(), 'g', 'c');
  const squashed = out.commits[1];
  // set /a temp=16 then unset /a temp cancels the set but keeps the unset
  assert.deepEqual(squashed.patch, {
    set: { '/a/b': { hum: 30, press: 101 } },
    unset: { '/a': ['temp'] },
    delete: [],
  });
});

test('sealed boundary cannot be crossed', () => {
  const repo = makeRepo();
  repo.commits[2].sealed = true; // commit b is sealed
  assert.throws(() => squash(repo, 'a', 'c'), (err) => {
    assert.equal(err.code, 'RANGE');
    assert.match(err.message, /sealed/);
    return true;
  });
});

test('range errors: unknown hash, empty range, non-descendant', () => {
  const repo = makeRepo();
  assert.throws(() => squash(repo, 'nope', 'c'), (err) => err.code === 'RANGE');
  assert.throws(() => squash(repo, 'c', 'nope'), (err) => err.code === 'RANGE');
  assert.throws(() => squash(repo, 'c', 'c'), (err) => {
    assert.equal(err.code, 'RANGE');
    assert.match(err.message, /empty range/);
    return true;
  });
  assert.throws(() => squash(repo, 'c', 'a'), (err) => err.code === 'RANGE');
});

test('squash range cannot contain branching children', () => {
  const repo = makeRepo();
  repo.commits.push({ hash: 'side', parents: ['b'], patch: { set: { '/c': { temp: 7 } } } });
  assert.throws(() => squash(repo, 'g', 'c'), (err) => {
    assert.equal(err.code, 'RANGE');
    assert.match(err.message, /branches from inside/);
    return true;
  });
});
