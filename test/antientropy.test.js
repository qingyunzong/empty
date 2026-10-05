import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replay } from '../src/replay.js';
import { Replica, syncReplicas } from '../src/replica.js';
import { computeDigest, diffDigests } from '../src/digest.js';
import { ev } from '../testlib/helpers.js';

const EVENTS = [
  ev({ id: 'a:1', member: 'a', epoch: 1, seq: 1, kind: 'join', clock: { a: 1 } }),
  ev({ id: 'a:2', member: 'a', epoch: 1, seq: 2, kind: 'interlock', valve: 'V1', clock: { a: 2 } }),
  ev({ id: 'a:3', member: 'a', epoch: 1, seq: 3, kind: 'bypass', valve: 'V2', clock: { a: 3 } }),
  ev({ id: 'b:1', member: 'b', epoch: 1, seq: 1, kind: 'join', clock: { b: 1 } }),
  ev({ id: 'b:2', member: 'b', epoch: 1, seq: 2, kind: 'reset', valve: 'V2', clock: { a: 3, b: 2 } }),
  ev({ id: 'b:3', member: 'b', epoch: 1, seq: 3, kind: 'interlock', valve: 'V3', clock: { a: 3, b: 3 } }),
];

test('anti-entropy pulls only the missing events', () => {
  const a = new Replica('a');
  const b = new Replica('b');
  a.addEvents(EVENTS.slice(0, 4)); // a:1 a:2 a:3 b:1
  b.addEvents(EVENTS.slice(2)); // a:3 b:1 b:2 b:3

  const round = syncReplicas(a, b);
  assert.deepEqual(round.transferred.toA.sort(), ['b:2', 'b:3']);
  assert.deepEqual(round.transferred.toB.sort(), ['a:1', 'a:2']);
  assert.equal(round.converged, true);
  assert.equal(a.digest().hash, b.digest().hash);
  assert.deepEqual(a.state().valves, replay(EVENTS).valves);
});

test('a second round transfers nothing and still proves convergence', () => {
  const a = new Replica('a');
  const b = new Replica('b');
  a.addEvents(EVENTS.slice(0, 3));
  b.addEvents(EVENTS.slice(3));
  syncReplicas(a, b);
  const again = syncReplicas(a, b);
  assert.deepEqual(again.transferred.toA, []);
  assert.deepEqual(again.transferred.toB, []);
  assert.equal(again.converged, true);
  assert.equal(again.certificate.count, EVENTS.length);
});

test('digest diff reports the exact divergence ranges per member', () => {
  const d1 = computeDigest(EVENTS.slice(0, 4));
  const d2 = computeDigest(EVENTS.slice(2));
  const diff = diffDigests(d1, d2);
  assert.equal(diff.equal, false);
  const byMember = Object.fromEntries(diff.divergence.map((d) => [d.member, d]));
  assert.deepEqual(byMember.a.onlyInA, [{ from: 1, to: 2 }]);
  assert.deepEqual(byMember.a.onlyInB, []);
  assert.deepEqual(byMember.b.onlyInB, [{ from: 2, to: 3 }]);
});

test('missingFrom plans a digest-only pull of exactly the lacking ids', () => {
  const a = new Replica('a');
  a.addEvents(EVENTS.slice(0, 2));
  const remoteDigest = computeDigest(EVENTS);
  assert.deepEqual(a.missingFrom(remoteDigest).sort(), ['a:3', 'b:1', 'b:2', 'b:3']);
});
