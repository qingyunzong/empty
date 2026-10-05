import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replay } from '../src/replay.js';
import { ev, permutations } from '../testlib/helpers.js';

// Acceptance 3: after a member leaves, fencing epochs reject stale writes while
// the member's old events stay in history.
const SET = [
  ev({ id: 'a:1', member: 'a', epoch: 1, seq: 1, kind: 'join', clock: { a: 1 } }),
  ev({ id: 'a:2', member: 'a', epoch: 1, seq: 2, kind: 'interlock', valve: 'V1', clock: { a: 2 } }),
  ev({ id: 'a:3', member: 'a', epoch: 1, seq: 3, kind: 'leave', clock: { a: 3 } }),
  // stale write at the abandoned epoch, causally after the leave -> fenced
  ev({ id: 'a:4', member: 'a', epoch: 1, seq: 4, kind: 'interlock', valve: 'V2', clock: { a: 4 } }),
  ev({ id: 'a:5', member: 'a', epoch: 2, seq: 5, kind: 'join', clock: { a: 5 } }),
  ev({ id: 'a:6', member: 'a', epoch: 2, seq: 6, kind: 'interlock', valve: 'V2', clock: { a: 6 } }),
  // low-epoch write causally after the epoch-2 join -> rejected by the higher epoch
  ev({ id: 'a:7', member: 'a', epoch: 1, seq: 7, kind: 'interlock', valve: 'V3', clock: { a: 7 } }),
];

test('leave fences same-epoch writes that causally follow it', () => {
  const r = replay(SET);
  const stale = r.rejected.find((x) => x.event.id === 'a:4');
  assert.equal(stale.reason, 'fenced-after-leave');
});

test('higher epoch rejects lower-epoch writes', () => {
  const r = replay(SET);
  const stale = r.rejected.find((x) => x.event.id === 'a:7');
  assert.equal(stale.reason, 'fenced-by-higher-epoch');
  assert.equal(r.valves.V3, undefined);
});

test('old events still participate in history after leave', () => {
  const r = replay(SET);
  assert.equal(r.valves.V1.status, 'INTERLOCKED'); // a:2, written before the leave
  assert.equal(r.valves.V2.status, 'INTERLOCKED'); // a:6, written at the new epoch
  assert.deepEqual(r.members.a, { epochs: [1, 2], currentEpoch: 2, leftEpochs: [1], active: true });
});

test('fencing outcome is identical for every arrival order (7! permutations)', () => {
  const summary = (r) => ({
    valves: r.valves,
    rejected: r.rejected.map((x) => `${x.event.id}:${x.reason}`).sort(),
  });
  const want = summary(replay(SET));
  let checked = 0;
  for (const perm of permutations(SET)) {
    assert.deepEqual(summary(replay(perm)), want);
    checked += 1;
  }
  assert.equal(checked, 5040);
});
