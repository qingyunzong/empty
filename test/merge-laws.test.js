import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeEvents, ingestAll, shardOf, shuffled, mulberry32,
  mergeAll, mergeStates, canonicalState, applyEvent,
} from './helpers.js';

// Acceptance 1: any sharded merge equals the full merge.
test('any sharded merge equals full merge', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const rnd = mulberry32(seed * 1000);
    const events = makeEvents(seed, 40);
    const full = canonicalState(ingestAll(events));
    for (let trial = 0; trial < 10; trial++) {
      const shards = shardOf(shuffled(events, rnd));
      const k = 2 + Math.floor(rnd() * 4);
      const groups = Array.from({ length: k }, () => []);
      shards.forEach((s, i) => groups[i % k].push(s));
      const groupStates = groups.map(mergeAll);
      const merged = canonicalState(mergeAll(shuffled(groupStates, rnd)));
      assert.equal(merged, full, `seed=${seed} trial=${trial}`);
    }
  }
});

test('merge is commutative and associative', () => {
  const events = makeEvents(7, 30);
  const shards = shardOf(events);
  const a = mergeAll(shards.slice(0, 10));
  const b = mergeAll(shards.slice(10, 20));
  const c = mergeAll(shards.slice(20));
  assert.equal(canonicalState(mergeStates(a, b)), canonicalState(mergeStates(b, a)));
  assert.equal(
    canonicalState(mergeStates(mergeStates(a, b), c)),
    canonicalState(mergeStates(a, mergeStates(b, c))),
  );
});

test('merge is idempotent', () => {
  const state = ingestAll(makeEvents(9, 25));
  const once = canonicalState(state);
  assert.equal(canonicalState(mergeStates(state, state)), once);
  assert.equal(canonicalState(mergeAll([state, state, state])), once);
});

test('re-ingest of the same events is a no-op', () => {
  const events = makeEvents(11, 25);
  const state = ingestAll(events);
  const before = canonicalState(state);
  for (const e of events) applyEvent(state, e);
  assert.equal(canonicalState(state), before);
});
