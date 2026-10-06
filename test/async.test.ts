import test from 'node:test';
import assert from 'node:assert/strict';
import { Fnv1aAdapter, SyncAsyncHashAdapter, fnv1a } from '../src/hash.js';
import { AbortError, RingBuilder, SharedHashComputer, StaleBuildError } from '../src/builder.js';
import { Router } from '../src/router.js';
import { BarrierHashAdapter, mulberry32, waitFor } from './helpers.js';

test('stale async hash results never enter a newer ring version', async () => {
  const adapter = new BarrierHashAdapter(fnv1a);
  const computer = new SharedHashComputer(adapter);
  const router = new Router(new RingBuilder(computer, 4));

  const stalePublish = router.publish([
    { id: 'old-a', weight: 1 },
    { id: 'old-b', weight: 1 },
  ]);
  const staleExpectation = assert.rejects(stalePublish, StaleBuildError);
  await waitFor(() => adapter.pendingCount === 8, 'old build hash calls');

  const freshPublish = router.publish([
    { id: 'new-a', weight: 1 },
    { id: 'new-b', weight: 1 },
  ]);
  await waitFor(() => adapter.calls.length === 16, 'new build hash calls');
  adapter.releaseMatching((key) => key.startsWith('new-'));
  const freshRing = await freshPublish;

  assert.strictEqual(freshRing.version, 2);
  assert.strictEqual(router.current, freshRing);

  adapter.releaseAll();
  await staleExpectation;

  assert.strictEqual(router.current, freshRing);
  assert.strictEqual(router.current.version, 2);
  assert.ok(router.current.vnodes.length > 0);
  for (const vnode of router.current.vnodes) {
    assert.ok(vnode.nodeId.startsWith('new-'), `stale vnode ${vnode.nodeId} leaked into ring`);
  }
  assert.ok(
    adapter.aborts.some((key) => key.startsWith('old-')),
    'superseded build computations should be cancelled',
  );
});

test('shared computations are deduplicated and cancelled only when all subscribers leave', async () => {
  const adapter = new BarrierHashAdapter(fnv1a);
  const computer = new SharedHashComputer(adapter);
  const builderA = new RingBuilder(computer, 4);
  const builderB = new RingBuilder(computer, 4);
  const nodes = [
    { id: 'a', weight: 1 },
    { id: 'b', weight: 1 },
  ];

  const first = builderA.build(nodes, 1);
  const second = builderB.build(nodes, 2);
  await waitFor(() => adapter.calls.length === 8, 'deduplicated hash computations');

  const firstExpectation = assert.rejects(first.promise, AbortError);
  first.cancel();
  await firstExpectation;
  assert.strictEqual(adapter.aborts.length, 0);

  adapter.releaseAll();
  const ring = await second.promise;
  assert.strictEqual(ring.vnodes.length, 8);

  const third = builderA.build(nodes, 3);
  const fourth = builderB.build(nodes, 4);
  await waitFor(() => adapter.calls.length === 16, 'recomputed hashes');
  const thirdExpectation = assert.rejects(third.promise, AbortError);
  const fourthExpectation = assert.rejects(fourth.promise, AbortError);
  third.cancel();
  assert.strictEqual(adapter.aborts.length, 0);
  fourth.cancel();
  assert.strictEqual(adapter.aborts.length, 8);
  await thirdExpectation;
  await fourthExpectation;
  assert.strictEqual(computer.inflightCount, 0);
});

test('read cursors keep routing with the configuration they were acquired on', async () => {
  const computer = new SharedHashComputer(new SyncAsyncHashAdapter(new Fnv1aAdapter()));
  const router = new Router(new RingBuilder(computer, 8));

  const initialCursor = router.acquireCursor();
  assert.strictEqual(initialCursor.routeHash(123), undefined);
  initialCursor.release();
  assert.strictEqual(router.activeCursors, 0);

  const ring1 = await router.publish([
    { id: 'a', weight: 1 },
    { id: 'b', weight: 1 },
  ]);
  const cursor = router.acquireCursor();
  const ring2 = await router.publish([
    { id: 'a', weight: 1 },
    { id: 'c', weight: 1 },
  ]);

  assert.notStrictEqual(ring2, ring1);
  assert.strictEqual(router.current.version, 2);
  assert.strictEqual(cursor.version, ring1.version);

  const rng = mulberry32(7);
  for (let i = 0; i < 200; i++) {
    const h = Math.floor(rng() * 0x100000000);
    assert.strictEqual(cursor.routeHash(h), ring1.ownerOfHash(h));
  }
  cursor.release();
  assert.strictEqual(router.activeCursors, 0);
  assert.throws(() => cursor.routeHash(1), /released/);
});
