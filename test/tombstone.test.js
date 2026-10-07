import test from 'node:test';
import assert from 'node:assert/strict';
import { replay, resolveWinner } from '../src/store.js';
import { permutations } from './helpers.js';

const joins = [
  { id: 'j1', member: 'alpha', epoch: 1, seq: 1, type: 'join', clock: { alpha: 1 } },
  { id: 'j2', member: 'beta', epoch: 1, seq: 1, type: 'join', clock: { beta: 1 } },
];

test('same-tick tombstone vs resurrect: same epoch, concurrent -> id decides, deterministic', () => {
  const bypass = { id: 'z-bypass', member: 'alpha', epoch: 1, seq: 2, type: 'bypass', key: 'fw-1', clock: { alpha: 2 } };
  const tombstone = { id: 'a-tomb', member: 'beta', epoch: 1, seq: 2, type: 'unbypass', key: 'fw-1', clock: { beta: 2 } };
  const events = [...joins, bypass, tombstone];

  assert.equal(resolveWinner([bypass, tombstone]).id, 'z-bypass');
  assert.equal(resolveWinner([tombstone, bypass]).id, 'z-bypass');

  for (const perm of permutations(events)) {
    const state = replay(perm);
    assert.equal(state.keys['fw-1'].state, 'bypassed');
    assert.equal(state.keys['fw-1'].winner, 'z-bypass');
  }

  const flipped = [
    ...joins,
    { ...bypass, id: 'a-bypass' },
    { ...tombstone, id: 'z-tomb' },
  ];
  for (const perm of permutations(flipped)) {
    const state = replay(perm);
    assert.equal(state.keys['fw-1'].state, 'tombstoned');
    assert.equal(state.keys['fw-1'].winner, 'z-tomb');
  }
});

test('same-tick: causally later tombstone beats concurrent-id ordering', () => {
  const bypass = { id: 'z-bypass', member: 'alpha', epoch: 1, seq: 2, type: 'bypass', key: 'fw-1', clock: { alpha: 2 } };
  const tombstone = { id: 'a-tomb', member: 'beta', epoch: 1, seq: 2, type: 'unbypass', key: 'fw-1', clock: { alpha: 2, beta: 2 } };
  const events = [...joins, bypass, tombstone];
  for (const perm of permutations(events)) {
    const state = replay(perm);
    assert.equal(state.keys['fw-1'].state, 'tombstoned');
    assert.equal(state.keys['fw-1'].winner, 'a-tomb');
  }
});

test('same-tick: higher member epoch wins over lower epoch regardless of id', () => {
  const membership = [
    { id: 'm1', member: 'alpha', epoch: 1, seq: 1, type: 'join', clock: { alpha: 1 } },
    { id: 'm2', member: 'alpha', epoch: 1, seq: 2, type: 'leave', clock: { alpha: 2 } },
    { id: 'm3', member: 'alpha', epoch: 2, seq: 3, type: 'join', clock: { alpha: 3 } },
    { id: 'm4', member: 'beta', epoch: 1, seq: 1, type: 'join', clock: { beta: 1 } },
  ];
  const tombstone = { id: 'z-tomb', member: 'beta', epoch: 1, seq: 2, type: 'unbypass', key: 'fw-1', clock: { beta: 2 } };
  const resurrect = { id: 'a-resurrect', member: 'alpha', epoch: 2, seq: 4, type: 'bypass', key: 'fw-1', clock: { alpha: 4 } };
  const events = [...membership, tombstone, resurrect];
  for (const perm of permutations(events)) {
    const state = replay(perm);
    assert.equal(state.keys['fw-1'].state, 'bypassed');
    assert.equal(state.keys['fw-1'].winner, 'a-resurrect');
  }
});
