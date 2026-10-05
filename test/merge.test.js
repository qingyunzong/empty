import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replay } from '../src/replay.js';
import { Replica, syncReplicas } from '../src/replica.js';
import { ev, shuffled } from '../testlib/helpers.js';

// Acceptance 1: three replicas receive the same events in different shuffled
// orders; after anti-entropy their final state equals a full rule-based replay.
const EVENTS = [
  ev({ id: 'a:1', member: 'a', epoch: 1, seq: 1, kind: 'join', clock: { a: 1 } }),
  ev({ id: 'b:1', member: 'b', epoch: 1, seq: 1, kind: 'join', clock: { b: 1 } }),
  ev({ id: 'c:1', member: 'c', epoch: 1, seq: 1, kind: 'join', clock: { c: 1 } }),
  ev({ id: 'a:2', member: 'a', epoch: 1, seq: 2, kind: 'interlock', valve: 'V1', clock: { a: 2 } }),
  ev({ id: 'b:2', member: 'b', epoch: 1, seq: 2, kind: 'bypass', valve: 'V1', clock: { a: 2, b: 2 } }),
  ev({ id: 'c:2', member: 'c', epoch: 1, seq: 2, kind: 'unbypass', valve: 'V1', clock: { a: 2, b: 2, c: 2 } }),
  ev({ id: 'a:3', member: 'a', epoch: 1, seq: 3, kind: 'bypass', valve: 'V2', clock: { a: 3 } }),
  ev({ id: 'b:3', member: 'b', epoch: 1, seq: 3, kind: 'reset', valve: 'V2', clock: { a: 3, b: 3 } }),
  ev({ id: 'c:3', member: 'c', epoch: 1, seq: 3, kind: 'interlock', valve: 'V2', clock: { a: 3, c: 3 } }),
];

test('three replicas, shuffled delivery: final state equals full replay', () => {
  const expected = replay(EVENTS);
  for (const seed of [1, 2, 3]) {
    const r = new Replica(`r${seed}`);
    r.addEvents(shuffled(EVENTS, seed * 1000 + 7));
    assert.deepEqual(r.state().valves, expected.valves);
    assert.deepEqual(r.state().members, expected.members);
  }
  assert.equal(expected.valves.V1.status, 'INTERLOCKED');
  assert.equal(expected.valves.V2.status, 'INTERLOCKED');
});

test('anti-entropy converges three partial replicas to the full replay state', () => {
  const r1 = new Replica('r1');
  const r2 = new Replica('r2');
  const r3 = new Replica('r3');
  r1.addEvents(EVENTS.slice(0, 5));
  r2.addEvents(EVENTS.slice(3, 7));
  r3.addEvents(EVENTS.slice(5));

  syncReplicas(r1, r2);
  syncReplicas(r2, r3);
  const last = syncReplicas(r1, r3);

  const expected = replay(EVENTS);
  const digests = [r1.digest(), r2.digest(), r3.digest()];
  assert.equal(digests[0].hash, digests[1].hash);
  assert.equal(digests[1].hash, digests[2].hash);
  for (const r of [r1, r2, r3]) assert.deepEqual(r.state().valves, expected.valves);
  assert.equal(last.converged, true);
  assert.equal(last.certificate.hash, digests[0].hash);
});

test('duplicate deliveries are idempotent', () => {
  const r = new Replica('r');
  r.addEvents(EVENTS);
  r.addEvents(shuffled(EVENTS, 42));
  assert.equal(r.size, EVENTS.length);
  assert.deepEqual(r.state().valves, replay(EVENTS).valves);
});
