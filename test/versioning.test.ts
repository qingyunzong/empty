import { test } from 'node:test';
import { deepEqual, equal, ok } from 'node:assert/strict';
import { Fnv1aAdapter, type HashAdapter } from '../src/hash.js';
import { Router } from '../src/router.js';
import { BlockingAdapter, buildRingSync } from './helpers/adapters.js';
import { Barrier, waitFor } from './helpers/sync.js';

const fnv = new Fnv1aAdapter();

test('weight change is published as a new ring version', async () => {
  const router = new Router(new Fnv1aAdapter());
  router.setNodes([
    { id: 'a', weight: 1 },
    { id: 'b', weight: 1 },
  ]);
  await router.idle();
  equal(router.current.version, 1);
  equal(router.current.ring.vnodes.length, 2);

  router.setNodes([
    { id: 'a', weight: 4 },
    { id: 'b', weight: 1 },
  ]);
  await router.idle();
  equal(router.current.version, 2);
  equal(router.current.ring.vnodes.length, 5);
  deepEqual(router.current.nodes, [
    { id: 'a', weight: 4 },
    { id: 'b', weight: 1 },
  ]);
});

test('stale async hash results can never enter the new ring', async () => {
  const adapter = new BlockingAdapter((input) => fnv.hash(input));
  const router = new Router(adapter);

  router.setNodes([
    { id: 'a', weight: 2 },
    { id: 'b', weight: 1 },
  ]);
  await waitFor(() => adapter.calls.length === 3);

  // Supersede v1 while its hash computations are still blocked.
  router.setNodes([{ id: 'c', weight: 1 }]);
  // v1's computations are unshared, so cancellation reaches the adapter
  // synchronously, before any gate opens.
  deepEqual([...adapter.aborts].sort(), ['a#0', 'a#1', 'b#0']);

  await waitFor(() => adapter.calls.length === 4);
  adapter.open();
  await router.idle();

  equal(router.current.version, 2);
  deepEqual(router.current.nodes, [{ id: 'c', weight: 1 }]);
  deepEqual(router.current.ring.nodeIds, ['c']);
  equal(router.current.ring.vnodes.length, 1);
});

test('late-resolving stale build cannot overwrite a newer published ring', async () => {
  const adapter = new BlockingAdapter((input) => fnv.hash(input));
  const router = new Router(adapter);

  router.setNodes([{ id: 'a', weight: 1 }]);
  await waitFor(() => adapter.calls.length === 1);
  router.setNodes([{ id: 'b', weight: 1 }]);
  await waitFor(() => adapter.calls.length === 2);

  // Publish v2 first, then let the stale v1 computation resolve.
  adapter.open('b#0');
  await waitFor(() => router.current.version === 2);
  adapter.open('a#0');
  await router.idle();

  equal(router.current.version, 2);
  deepEqual(router.current.ring.nodeIds, ['b']);
});

test('in-flight hash computations are shared across superseded builds', async () => {
  const adapter = new BlockingAdapter((input) => fnv.hash(input));
  const router = new Router(adapter);

  router.setNodes([{ id: 'a', weight: 1 }]);
  await waitFor(() => adapter.calls.length === 1);

  // v2 still needs "a#0": it must share v1's in-flight computation.
  router.setNodes([
    { id: 'a', weight: 1 },
    { id: 'b', weight: 1 },
  ]);
  await waitFor(() => adapter.calls.length === 2);

  equal(adapter.calls.filter((c) => c === 'a#0').length, 1, 'shared input hashed only once');
  deepEqual(adapter.aborts, [], 'shared computation must not be cancelled');

  adapter.open();
  await router.idle();
  equal(router.current.version, 2);
  deepEqual(router.current.ring.nodeIds, ['a', 'b']);
  const expected = fnv.hash('a#0');
  ok(router.current.ring.vnodes.some((v) => v.nodeId === 'a' && v.hash === expected));
});

test('cancelled shared computation is aborted while blocked at a barrier', async () => {
  const barrier = new Barrier(2);
  const aborts: string[] = [];
  const adapter: HashAdapter = {
    hash(input: string, signal?: AbortSignal): Promise<number> {
      signal?.addEventListener('abort', () => aborts.push(input), { once: true });
      return barrier.arrive().then(() => 42);
    },
  };
  const router = new Router(adapter);

  router.setNodes([{ id: 'x', weight: 1 }]);
  await waitFor(() => barrier.arrived === 1);

  // Supersede v1; "x#0" is unshared, so the blocked computation is cancelled.
  router.setNodes([{ id: 'y', weight: 1 }]);
  deepEqual(aborts, ['x#0'], 'cancellation observed before the barrier releases');

  await barrier.arrive(); // release the blocked stale computation
  await router.idle();

  equal(router.current.version, 2);
  deepEqual(router.current.ring.nodeIds, ['y'], 'stale result must not enter the new ring');
});

test('read cursor pins the old ring configuration', async () => {
  const adapter = new Fnv1aAdapter();
  const router = new Router(adapter);

  const oldNodes = [
    { id: 'a', weight: 2 },
    { id: 'b', weight: 1 },
  ];
  const newNodes = [
    { id: 'a', weight: 5 },
    { id: 'd', weight: 3 },
  ];
  router.setNodes(oldNodes);
  await router.idle();
  const oldCursor = router.acquireCursor();
  equal(oldCursor.version, 1);

  router.setNodes(newNodes);
  await router.idle();
  const newCursor = router.acquireCursor();
  equal(newCursor.version, 2);

  const oldRing = buildRingSync((i) => fnv.hash(i), oldNodes);
  const newRing = buildRingSync((i) => fnv.hash(i), newNodes);
  let divergent = 0;
  for (let k = 0; k < 300; k++) {
    const key = `key-${k}`;
    const hash = fnv.hash(key);
    equal(await oldCursor.route(key), oldRing.owner(hash), 'old cursor must use the old ring');
    equal(await newCursor.route(key), newRing.owner(hash), 'new cursor must use the new ring');
    if (oldRing.owner(hash) !== newRing.owner(hash)) divergent++;
  }
  ok(divergent > 0, 'test keys must actually exercise both configurations');
  deepEqual(oldCursor.nodes, oldNodes, 'cursor keeps the old node configuration');
});

test('deliberate collisions under async gating produce a deterministic ring', async () => {
  const adapter = new BlockingAdapter(() => 0xdeadbeef);
  const router = new Router(adapter);
  router.setNodes([
    { id: 'b', weight: 2 },
    { id: 'a', weight: 2 },
    { id: 'c', weight: 1 },
  ]);
  await waitFor(() => adapter.calls.length === 5);
  adapter.open();
  await router.idle();

  const ring = router.current.ring;
  deepEqual(
    ring.vnodes.map((v) => `${v.nodeId}#${v.replicaIndex}`),
    ['a#0', 'a#1', 'b#0', 'b#1', 'c#0'],
    'hash collisions order by node id then replica index',
  );
  const cursor = router.acquireCursor();
  adapter.open('anything'); // cursor lookups also go through the blocking adapter
  equal(await cursor.route('anything'), 'a');
  deepEqual(await cursor.routeReplicas('anything', 3), ['a', 'b', 'c']);
});

test('adapter failures surface through idle()', async () => {
  const router = new Router({
    hash(): Promise<number> {
      return Promise.reject(new Error('boom'));
    },
  });
  router.setNodes([{ id: 'a', weight: 1 }]);
  let caught: unknown = null;
  try {
    await router.idle();
  } catch (err) {
    caught = err;
  }
  ok(caught instanceof Error && caught.message === 'boom');
});
