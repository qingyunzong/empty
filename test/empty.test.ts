import { test } from 'node:test';
import { deepEqual, equal, ok } from 'node:assert/strict';
import { Fnv1aAdapter } from '../src/hash.js';
import { planMigration, type MigrationInterval } from '../src/migration.js';
import { Ring } from '../src/ring.js';
import { Router } from '../src/router.js';
import { buildRingSync } from './helpers/adapters.js';

function contains(interval: MigrationInterval, hash: number): boolean {
  if (interval.from === interval.to) return true; // full circle
  if (interval.from < interval.to) return hash > interval.from && hash <= interval.to;
  return hash > interval.from || hash <= interval.to; // wraps around
}

const fnv = new Fnv1aAdapter();
const RING = buildRingSync((i) => fnv.hash(i), [
  { id: 'a', weight: 2 },
  { id: 'b', weight: 1 },
]);

test('router starts on an empty version-0 ring', async () => {
  const router = new Router(fnv);
  equal(router.current.version, 0);
  ok(router.current.ring.isEmpty);
  equal(await router.acquireCursor().route('key'), undefined);
  deepEqual(await router.acquireCursor().routeReplicas('key', 3), []);
});

test('publishing an empty node set yields an empty ring version', async () => {
  const router = new Router(fnv);
  router.setNodes([]);
  await router.idle();
  equal(router.current.version, 1);
  ok(router.current.ring.isEmpty);
  equal(await router.acquireCursor().route('key'), undefined);
});

test('migration plan between two empty rings is empty', () => {
  deepEqual(planMigration(new Ring([]), new Ring([])), []);
});

test('empty -> non-empty plan covers the whole circle with src null', () => {
  const plan = planMigration(new Ring([]), RING);
  ok(plan.length > 0);
  for (const interval of plan) equal(interval.src, null);
  for (let k = 0; k < 300; k++) {
    const hash = fnv.hash(`key-${k}`);
    const interval = plan.find((iv) => contains(iv, hash));
    ok(interval, `key-${k} must be covered by the plan`);
    equal(interval.dst, RING.owner(hash));
  }
});

test('non-empty -> empty plan sends everything to null', () => {
  const plan = planMigration(RING, new Ring([]));
  ok(plan.length > 0);
  for (const interval of plan) {
    equal(interval.dst, null);
    ok(interval.src === 'a' || interval.src === 'b');
  }
  for (let k = 0; k < 300; k++) {
    const hash = fnv.hash(`key-${k}`);
    const interval = plan.find((iv) => contains(iv, hash));
    ok(interval, `key-${k} must be covered by the plan`);
    equal(interval.src, RING.owner(hash));
  }
});
