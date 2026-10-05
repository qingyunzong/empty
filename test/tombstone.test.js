import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replay } from '../src/replay.js';
import { ev, permutations } from '../testlib/helpers.js';

// Acceptance 2: a tombstone (unbypass) and a resurrection (bypass) at the same
// logical moment are decided deterministically by member epoch, then causality,
// then id. Wall-clock timestamps never break ties.
const JOINS = [
  ev({ id: 'a:1', member: 'a', epoch: 1, seq: 1, kind: 'join', clock: { a: 1 } }),
  ev({ id: 'b:1', member: 'b', epoch: 1, seq: 1, kind: 'join', clock: { b: 1 } }),
];

function bypassedStatus(events) {
  const r = replay([...JOINS, ...events]);
  return r.valves.V1?.bypassed ?? false;
}

function assertOrderIndependent(events, expected) {
  for (const perm of permutations(events)) {
    assert.equal(bypassedStatus(perm), expected);
  }
}

test('same epoch, same moment: higher id wins (tombstone b:2 beats bypass a:2)', () => {
  const events = [
    ev({ id: 'a:2', member: 'a', epoch: 1, seq: 2, kind: 'bypass', valve: 'V1', clock: { a: 2 }, ts: 100 }),
    ev({ id: 'b:2', member: 'b', epoch: 1, seq: 2, kind: 'unbypass', valve: 'V1', clock: { b: 2 }, ts: 100 }),
  ];
  assertOrderIndependent(events, false);
});

test('same epoch, same moment: higher id wins (bypass b:2 beats tombstone a:2)', () => {
  const events = [
    ev({ id: 'b:2', member: 'b', epoch: 1, seq: 2, kind: 'bypass', valve: 'V1', clock: { b: 2 }, ts: 100 }),
    ev({ id: 'a:2', member: 'a', epoch: 1, seq: 2, kind: 'unbypass', valve: 'V1', clock: { a: 2 }, ts: 100 }),
  ];
  assertOrderIndependent(events, true);
});

test('higher member epoch beats higher id (epoch-2 tombstone kills epoch-1 resurrection)', () => {
  const events = [
    ev({ id: 'a:3', member: 'a', epoch: 2, seq: 3, kind: 'join', clock: { a: 3 } }),
    ev({ id: 'a:4', member: 'a', epoch: 2, seq: 4, kind: 'unbypass', valve: 'V1', clock: { a: 4 }, ts: 100 }),
    ev({ id: 'b:2', member: 'b', epoch: 1, seq: 2, kind: 'bypass', valve: 'V1', clock: { b: 2 }, ts: 100 }),
  ];
  assertOrderIndependent(events, false);
});

test('higher member epoch beats higher id (epoch-2 bypass survives epoch-1 tombstone)', () => {
  const events = [
    ev({ id: 'a:3', member: 'a', epoch: 2, seq: 3, kind: 'join', clock: { a: 3 } }),
    ev({ id: 'a:4', member: 'a', epoch: 2, seq: 4, kind: 'bypass', valve: 'V1', clock: { a: 4 }, ts: 100 }),
    ev({ id: 'b:2', member: 'b', epoch: 1, seq: 2, kind: 'unbypass', valve: 'V1', clock: { b: 2 }, ts: 100 }),
  ];
  assertOrderIndependent(events, true);
});

test('causally later resurrection wins even at lower epoch (rule applies only at the same moment)', () => {
  const events = [
    ev({ id: 'a:3', member: 'a', epoch: 2, seq: 3, kind: 'join', clock: { a: 3 } }),
    ev({ id: 'a:4', member: 'a', epoch: 2, seq: 4, kind: 'unbypass', valve: 'V1', clock: { a: 4 } }),
    ev({ id: 'b:5', member: 'b', epoch: 1, seq: 5, kind: 'bypass', valve: 'V1', clock: { a: 4, b: 5 } }),
  ];
  assertOrderIndependent(events, true);
});

test('causally later tombstone deletes the bypass it observed', () => {
  const events = [
    ev({ id: 'b:2', member: 'b', epoch: 1, seq: 2, kind: 'bypass', valve: 'V1', clock: { b: 2 } }),
    ev({ id: 'a:4', member: 'a', epoch: 1, seq: 4, kind: 'unbypass', valve: 'V1', clock: { a: 4, b: 2 } }),
  ];
  assertOrderIndependent(events, false);
});

test('timestamps are ignored: identical ts on every event changes nothing', () => {
  const mk = (ts) => [
    ev({ id: 'a:2', member: 'a', epoch: 1, seq: 2, kind: 'bypass', valve: 'V1', clock: { a: 2 }, ts }),
    ev({ id: 'b:2', member: 'b', epoch: 1, seq: 2, kind: 'unbypass', valve: 'V1', clock: { b: 2 }, ts }),
  ];
  assert.equal(bypassedStatus(mk(1)), bypassedStatus(mk(999999)));
});
