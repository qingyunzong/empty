import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEvents, ingestAll, shardOf, mergeStates, canonicalState } from './helpers.js';

function* permutations(arr) {
  if (arr.length <= 1) { yield arr; return; }
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const perm of permutations(rest)) yield [arr[i], ...perm];
  }
}

// Acceptance 4: for <=10 events, enumerate every merge order and compare.
test('all merge orders of 7 events agree (5040 permutations)', () => {
  const events = makeEvents(42, 7, { nodes: ['t1', 't2'] });
  const reference = canonicalState(ingestAll(events));
  const shards = shardOf(events);
  let checked = 0;
  for (const order of permutations([...shards.keys()])) {
    let acc = shards[order[0]];
    for (let i = 1; i < order.length; i++) acc = mergeStates(acc, shards[order[i]]);
    assert.equal(canonicalState(acc), reference, `order=${order.join(',')}`);
    checked++;
  }
  assert.equal(checked, 5040);
});

test('all pairwise merge trees of 6 events agree', () => {
  const events = makeEvents(43, 6);
  const reference = canonicalState(ingestAll(events));
  const shards = shardOf(events);
  let checked = 0;
  for (const order of permutations([...shards.keys()])) {
    // left fold and right fold for each order
    let left = shards[order[0]];
    for (let i = 1; i < order.length; i++) left = mergeStates(left, shards[order[i]]);
    let right = shards[order[order.length - 1]];
    for (let i = order.length - 2; i >= 0; i--) right = mergeStates(shards[order[i]], right);
    assert.equal(canonicalState(left), reference);
    assert.equal(canonicalState(right), reference);
    checked++;
  }
  assert.equal(checked, 720);
});
