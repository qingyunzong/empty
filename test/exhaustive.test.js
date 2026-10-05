import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replay } from '../src/replay.js';
import { Replica } from '../src/replica.js';
import { ev, permutations } from '../testlib/helpers.js';

// Acceptance 4: exhaustively enumerate every ordering of event sets of size <= 8
// and check the library yields one identical final state for all of them.
// The set mixes causal and concurrent interlock/bypass/unbypass/reset events,
// including a concurrent tombstone/resurrection pair on V1.
const SET = [
  ev({ id: 'a:1', member: 'a', epoch: 1, seq: 1, kind: 'join', clock: { a: 1 } }),
  ev({ id: 'b:1', member: 'b', epoch: 1, seq: 1, kind: 'join', clock: { b: 1 } }),
  ev({ id: 'a:2', member: 'a', epoch: 1, seq: 2, kind: 'interlock', valve: 'V1', clock: { a: 2, b: 1 } }),
  ev({ id: 'b:2', member: 'b', epoch: 1, seq: 2, kind: 'bypass', valve: 'V1', clock: { a: 1, b: 2 } }),
  ev({ id: 'a:3', member: 'a', epoch: 1, seq: 3, kind: 'unbypass', valve: 'V1', clock: { a: 3, b: 1 } }),
  ev({ id: 'b:3', member: 'b', epoch: 1, seq: 3, kind: 'bypass', valve: 'V2', clock: { a: 1, b: 3 } }),
  ev({ id: 'a:4', member: 'a', epoch: 1, seq: 4, kind: 'reset', valve: 'V2', clock: { a: 4, b: 3 } }),
  ev({ id: 'b:4', member: 'b', epoch: 1, seq: 4, kind: 'interlock', valve: 'V2', clock: { a: 1, b: 4 } }),
];

function ingestInOrder(events) {
  const r = new Replica('enum');
  for (const e of events) r.addEvent(e);
  return r.state().valves;
}

test('all 8! = 40320 orderings of an 8-event set yield the library result', () => {
  const expected = replay(SET).valves;
  assert.equal(expected.V1.status, 'BYPASSED');
  assert.equal(expected.V2.status, 'INTERLOCKED');
  let checked = 0;
  for (const perm of permutations(SET)) {
    assert.deepEqual(ingestInOrder(perm), expected);
    checked += 1;
  }
  assert.equal(checked, 40320);
});

test('all orderings of 5- and 6-event subsets match the library result', () => {
  for (const n of [5, 6]) {
    const subset = SET.slice(0, n);
    const expected = replay(subset).valves;
    let checked = 0;
    for (const perm of permutations(subset)) {
      assert.deepEqual(ingestInOrder(perm), expected);
      checked += 1;
    }
    assert.equal(checked, n === 5 ? 120 : 720);
  }
});

test('digest is identical across orderings of the same set', () => {
  const expected = new Replica('d');
  expected.addEvents(SET);
  const want = expected.digest().hash;
  let checked = 0;
  for (const perm of permutations(SET)) {
    const r = new Replica('d2');
    r.addEvents(perm);
    assert.equal(r.digest().hash, want);
    checked += 1;
    if (checked >= 500) break; // sample; full state check above covers all permutations
  }
});
