import { test } from 'node:test';
import { deepEqual, equal } from 'node:assert/strict';
import { ConstantAdapter, FewValuesAdapter, buildRingSync } from './helpers/adapters.js';
import { ReferenceRing } from './helpers/reference-ring.js';

const NODES = [
  { id: 'b', weight: 2 },
  { id: 'a', weight: 2 },
  { id: 'c', weight: 1 },
];

test('total collision: vnodes order by node id then replica index', () => {
  const adapter = new ConstantAdapter(0xdeadbeef);
  const ring = buildRingSync(() => adapter.hash(), NODES);
  deepEqual(
    ring.vnodes.map((v) => `${v.nodeId}#${v.replicaIndex}`),
    ['a#0', 'a#1', 'b#0', 'b#1', 'c#0'],
  );
  // Every key hash collides with every vnode hash, so the collision-group
  // head (lowest node id, replica 0) owns everything.
  equal(ring.owner(0xdeadbeef), 'a');
  equal(ring.owner(0), 'a');
  equal(ring.owner(0xffffffff), 'a');
});

test('total collision: replicas still land on distinct physical nodes', () => {
  const adapter = new ConstantAdapter(7);
  const ring = buildRingSync(() => adapter.hash(), NODES);
  deepEqual(ring.owners(7, 3), ['a', 'b', 'c']);
  deepEqual(ring.owners(7, 99), ['a', 'b', 'c']);
  deepEqual(ring.owners(7, 2), ['a', 'b']);
});

test('heavy collisions: binary-search ring matches fully-sorted reference', () => {
  const adapter = new FewValuesAdapter([11, 11, 23]);
  const nodes = [
    { id: 'n1', weight: 3 },
    { id: 'n2', weight: 3 },
    { id: 'n3', weight: 2 },
    { id: 'n4', weight: 1 },
  ];
  const ring = buildRingSync((i) => adapter.hash(i), nodes);
  const reference = new ReferenceRing(ring.vnodes);
  // Probe every hash value around the collision points, plus wrap-around.
  const probes = [0, 1, 10, 11, 12, 22, 23, 24, 0xfffffffe, 0xffffffff];
  for (const hash of probes) {
    equal(ring.owner(hash), reference.owner(hash), `owner mismatch at ${hash}`);
    deepEqual(ring.owners(hash, 4), reference.owners(hash, 4), `replicas mismatch at ${hash}`);
  }
});
