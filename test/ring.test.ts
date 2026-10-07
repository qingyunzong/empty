import { test } from 'node:test';
import { deepEqual, equal, ok, throws } from 'node:assert/strict';
import { Ring, vnodeInputs } from '../src/ring.js';
import { buildRingSync, makeRandomAdapter } from './helpers/adapters.js';
import { ReferenceRing } from './helpers/reference-ring.js';

test('ring lookups match the fully-sorted reference ring across seeds', () => {
  for (let seed = 1; seed <= 5; seed++) {
    const adapter = makeRandomAdapter(seed * 7919);
    const nodes = [];
    for (let n = 0; n < 6; n++) nodes.push({ id: `node-${n}`, weight: 1 + ((seed + n) % 3) });
    const ring = buildRingSync((input) => adapter.hash(input) as number, nodes);
    const reference = new ReferenceRing(ring.vnodes);
    for (let k = 0; k < 500; k++) {
      const hash = (adapter.hash(`key-${k}`) as number) >>> 0;
      equal(ring.owner(hash), reference.owner(hash), `owner mismatch seed=${seed} key=${k}`);
      deepEqual(ring.owners(hash, 3), reference.owners(hash, 3), `replicas mismatch seed=${seed} key=${k}`);
    }
  }
});

test('routing is deterministic for identical inputs', () => {
  const adapter = makeRandomAdapter(42);
  const nodes = [
    { id: 'a', weight: 3 },
    { id: 'b', weight: 2 },
  ];
  const first = buildRingSync((i) => adapter.hash(i) as number, nodes);
  const second = buildRingSync((i) => adapter.hash(i) as number, [...nodes].reverse());
  deepEqual(first.vnodes, second.vnodes);
});

test('weight controls the number of virtual nodes', () => {
  const inputs = vnodeInputs([
    { id: 'a', weight: 4 },
    { id: 'b', weight: 1 },
  ]);
  equal(inputs.filter((v) => v.nodeId === 'a').length, 4);
  equal(inputs.filter((v) => v.nodeId === 'b').length, 1);
  throws(() => vnodeInputs([{ id: 'bad', weight: 0 }]));
});

test('replicas are distinct physical nodes and capped at node count', () => {
  const adapter = makeRandomAdapter(7);
  const nodes = [
    { id: 'a', weight: 5 },
    { id: 'b', weight: 5 },
    { id: 'c', weight: 5 },
  ];
  const ring = buildRingSync((i) => adapter.hash(i) as number, nodes);
  for (let k = 0; k < 200; k++) {
    const hash = (adapter.hash(`k${k}`) as number) >>> 0;
    const replicas = ring.owners(hash, 3);
    equal(replicas.length, 3);
    equal(new Set(replicas).size, 3, 'replicas must be distinct physical nodes');
    deepEqual(ring.owners(hash, 10).sort(), ['a', 'b', 'c']);
  }
});

test('empty ring routes nothing', () => {
  const ring = new Ring([]);
  ok(ring.isEmpty);
  equal(ring.owner(123), undefined);
  deepEqual(ring.owners(123, 3), []);
  deepEqual(ring.nodeIds, []);
});
