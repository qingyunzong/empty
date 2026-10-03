import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyEvents } from '../src/causal.js';

const decision = (decisions, id) => decisions.find((d) => d.id === id);

test('acceptance 3: causally ordered and released occupancy is admitted', () => {
  const decisions = verifyEvents({
    events: [
      { id: 'm1', shuttle: 's1', op: 'enter', lane: 'L1' },
      { id: 'x1', shuttle: 's1', op: 'exit', lane: 'L1', of: 'm1' },
      { id: 'm2', shuttle: 's2', op: 'enter', lane: 'L1', after: ['x1'] },
    ],
  });
  assert.equal(decision(decisions, 'm1').verdict, 'admitted');
  assert.equal(decision(decisions, 'm2').verdict, 'admitted');
});

test('acceptance 3: concurrent occupants stay pending with resolvable conditions', () => {
  const decisions = verifyEvents({
    events: [
      { id: 'm1', shuttle: 's1', op: 'enter', lane: 'L1' },
      { id: 'm2', shuttle: 's2', op: 'enter', lane: 'L1' },
    ],
  });
  for (const id of ['m1', 'm2']) {
    const d = decision(decisions, id);
    assert.equal(d.verdict, 'pending');
    assert.equal(d.reason, 'concurrent-occupant');
  }
  assert.deepEqual(decision(decisions, 'm1').waitFor, ['m2']);
  assert.deepEqual(decision(decisions, 'm2').waitFor, ['m1']);
});

test('prior occupant without release blocks later entrant', () => {
  const decisions = verifyEvents({
    events: [
      { id: 'm1', shuttle: 's1', op: 'enter', lane: 'L1' },
 // no exit event
      { id: 'm2', shuttle: 's2', op: 'enter', lane: 'L1', after: ['m1'] },
    ],
  });
  assert.equal(decision(decisions, 'm1').verdict, 'admitted');
  const d2 = decision(decisions, 'm2');
  assert.equal(d2.verdict, 'pending');
  assert.equal(d2.reason, 'occupant-unreleased');
  assert.deepEqual(d2.waitFor, ['m1']);
});

test('adding a causal order resolves the conflict (condition is resolvable)', () => {
  const before = verifyEvents({
    events: [
      { id: 'm1', shuttle: 's1', op: 'enter', lane: 'L1' },
      { id: 'x1', shuttle: 's1', op: 'exit', lane: 'L1', of: 'm1' },
      { id: 'm2', shuttle: 's2', op: 'enter', lane: 'L1' },
    ],
  });
  assert.equal(decision(before, 'm2').verdict, 'pending');

  const after = verifyEvents({
    events: [
      { id: 'm1', shuttle: 's1', op: 'enter', lane: 'L1' },
      { id: 'x1', shuttle: 's1', op: 'exit', lane: 'L1', of: 'm1' },
      { id: 'm2', shuttle: 's2', op: 'enter', lane: 'L1', after: ['x1'] },
    ],
  });
  assert.equal(decision(after, 'm1').verdict, 'admitted');
  assert.equal(decision(after, 'm2').verdict, 'admitted');
});

test('unknown or undeclared lane state never blocks', () => {
  const decisions = verifyEvents({
    lanes: [
      { id: 'L1', state: 'unknown' },
      { id: 'L2', state: 'free' },
    ],
    events: [
      { id: 'm1', shuttle: 's1', op: 'enter', lane: 'L1' },
      { id: 'm2', shuttle: 's2', op: 'enter', lane: 'L2' },
      { id: 'm3', shuttle: 's3', op: 'enter', lane: 'L9' }, // undeclared lane
    ],
  });
  assert.ok(decisions.every((d) => d.verdict === 'admitted'));
});

test('known external occupancy blocks with an external reason', () => {
  const decisions = verifyEvents({
    lanes: [{ id: 'L1', state: 'occupied' }],
    events: [{ id: 'm1', shuttle: 's1', op: 'enter', lane: 'L1' }],
  });
  const d = decision(decisions, 'm1');
  assert.equal(d.verdict, 'pending');
  assert.equal(d.reason, 'lane-occupied-external');
});

test('per-shuttle program order counts as causal order', () => {
  const decisions = verifyEvents({
    events: [
      { id: 'm1', shuttle: 's1', op: 'enter', lane: 'L1' },
      { id: 'x1', shuttle: 's1', op: 'exit', lane: 'L1', of: 'm1' },
      { id: 'm2', shuttle: 's1', op: 'enter', lane: 'L1' }, // same shuttle, no explicit after
    ],
  });
  assert.equal(decision(decisions, 'm2').verdict, 'admitted');
});

test('transitive causal chains are honored', () => {
  const decisions = verifyEvents({
    events: [
      { id: 'm1', shuttle: 's1', op: 'enter', lane: 'L1' },
      { id: 'x1', shuttle: 's1', op: 'exit', lane: 'L1', of: 'm1' },
      { id: 'h1', shuttle: 's2', op: 'enter', lane: 'L2', after: ['x1'] },
      { id: 'm2', shuttle: 's3', op: 'enter', lane: 'L1', after: ['h1'] },
    ],
  });
  assert.equal(decision(decisions, 'm2').verdict, 'admitted');
});
