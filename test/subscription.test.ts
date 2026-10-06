import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ControllableExecutor } from '../src/executor.js';
import { SubscriptionLibrary, syncAuthorizedView } from '../src/subscription.js';
import type { Item, Message, Policy } from '../src/types.js';

/** Drain the microtask queue so completed tasks and recomputes settle. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const item = (id: string, extra: Record<string, unknown> = {}): Item => ({ id, ...extra });

const allowSet = (name: string, ids: readonly string[]): Policy => ({
  name,
  allows: (it) => ids.includes(it.id),
});

function assertVersionsBound(messages: readonly Message[]): void {
  messages.forEach((m, i) => {
    assert.equal(m.version, i + 1, `message #${i} must carry version ${i + 1}`);
  });
}

test('policy revocation publishes deletes before any new data', async () => {
  const exec = new ControllableExecutor();
  const lib = new SubscriptionLibrary(allowSet('A', ['1', '2', '3']), exec);
  for (const id of ['1', '2', '3', '4', '5']) lib.upsert(item(id));
  exec.completeAll();
  await flush();
  assert.deepEqual([...lib.visibleIds].sort(), ['1', '2', '3']);

  const base = lib.messages.length;
  lib.setPolicy(allowSet('B', ['3', '4', '5'])); // revoke 1,2; grant 4,5
  exec.completeAll();
  await flush();

  const batch = lib.messages.slice(base);
  assert.deepEqual(
    batch.map((m) => (m.kind === 'delete' ? `del:${m.id}` : `add:${m.item.id}`)),
    ['del:1', 'del:2', 'add:4', 'add:5'],
  );
  const lastDelete = batch.map((m) => m.kind).lastIndexOf('delete');
  const firstAdd = batch.map((m) => m.kind).indexOf('add');
  assert.ok(lastDelete < firstAdd, 'every delete must precede every add');
  assert.deepEqual([...lib.visibleIds].sort(), ['3', '4', '5']);
  assertVersionsBound(lib.messages);
});

test('every message is bound to a contiguous increasing version', async () => {
  const exec = new ControllableExecutor();
  const lib = new SubscriptionLibrary(allowSet('all', ['a', 'b', 'c']), exec);
  lib.upsert(item('a'));
  lib.upsert(item('b'));
  exec.completeAll();
  await flush();
  lib.upsert(item('c'));
  lib.remove('a');
  exec.completeAll();
  await flush();
  assertVersionsBound(lib.messages);
  assert.equal(lib.currentVersion, lib.messages.length);
  assert.ok(lib.messages.length > 0);
});

test('stale async query results are never published', async () => {
  const exec = new ControllableExecutor();
  const p1 = allowSet('p1', ['a1', 'a2']);
  const p2 = allowSet('p2', ['b1']);
  const p3 = allowSet('p3', ['a1', 'a2', 'b1']);
  const lib = new SubscriptionLibrary(p1, exec);
  lib.upsert(item('a1'));
  lib.upsert(item('a2'));
  lib.upsert(item('b1'));
  exec.completeAll();
  await flush();
  const settled = lib.messages.length;
  assert.deepEqual([...lib.visibleIds].sort(), ['a1', 'a2']);

  lib.setPolicy(p2);
  const staleIds = [...exec.pendingIds];
  lib.setPolicy(p3); // supersedes p2 before its async checks complete
  const freshIds = exec.pendingIds.filter((id) => !staleIds.includes(id));

  // Complete the stale generation first: it must publish nothing.
  for (const id of staleIds) exec.complete(id);
  await flush();
  assert.equal(lib.messages.length, settled, 'stale generation must not publish');
  assert.deepEqual([...lib.visibleIds].sort(), ['a1', 'a2']);

  // Complete the fresh generation: only the real diff appears.
  for (const id of freshIds) exec.complete(id);
  await flush();
  const batch = lib.messages.slice(settled);
  assert.deepEqual(
    batch.map((m) => (m.kind === 'add' ? `add:${m.item.id}` : `del:${m.id}`)),
    ['add:b1'],
  );
  assert.deepEqual([...lib.visibleIds].sort(), ['a1', 'a2', 'b1']);
  assertVersionsBound(lib.messages);
});

test('out-of-order completion reconciles with synchronous authorization queries', async () => {
  // Deterministic PRNG (mulberry32) for reproducible randomness.
  let seed = 0xC0FFEE;
  const rand = () => {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;

  const exec = new ControllableExecutor();
  const policies: Policy[] = [
    { name: 'even', allows: (it) => Number(it.id.slice(1)) % 2 === 0 },
    { name: 'odd', allows: (it) => Number(it.id.slice(1)) % 2 === 1 },
    allowSet('few', ['i1', 'i3', 'i7']),
    allowSet('none', []),
    { name: 'all', allows: () => true },
  ];
  const items = new Map<string, Item>();
  const lib = new SubscriptionLibrary(pick(policies), exec);
  const received: Message[] = [];
  lib.onMessage((m) => received.push(m));

  for (let round = 0; round < 40; round++) {
    const ops = 1 + Math.floor(rand() * 3);
    for (let k = 0; k < ops; k++) {
      const id = `i${1 + Math.floor(rand() * 8)}`;
      switch (Math.floor(rand() * 3)) {
        case 0: {
          const it = item(id, { round });
          items.set(id, it);
          lib.upsert(it);
          break;
        }
        case 1:
          items.delete(id);
          lib.remove(id);
          break;
        default:
          lib.setPolicy(pick(policies));
      }
    }
    // Complete pending async checks in a random (out-of-order) permutation.
    const order = exec.pendingIds;
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    exec.completeAll(order);
    await flush();

    assert.ok(lib.reconcile(), `round ${round}: live view must match sync auth query`);
  }

  // Final reconciliation against a synchronous authorization query.
  const finalPolicy = policies[4]!; // 'all'
  lib.setPolicy(finalPolicy);
  exec.completeAll();
  await flush();
  const expected = syncAuthorizedView(items, finalPolicy);
  assert.deepEqual([...lib.visibleIds].sort(), [...expected.keys()].sort());
  assert.ok(lib.reconcile());

  // Listeners observed exactly the published stream, version-bound.
  assert.deepEqual(received, [...lib.messages]);
  assertVersionsBound(lib.messages);
});

test('data removal under an unchanged policy emits a delete', async () => {
  const exec = new ControllableExecutor();
  const lib = new SubscriptionLibrary({ name: 'all', allows: () => true }, exec);
  lib.upsert(item('x'));
  lib.upsert(item('y'));
  exec.completeAll();
  await flush();
  lib.remove('x');
  exec.completeAll();
  await flush();
  const last = lib.messages.at(-1)!;
  assert.deepEqual(last, { kind: 'delete', id: 'x', version: lib.currentVersion });
  assert.deepEqual([...lib.visibleIds], ['y']);
  assertVersionsBound(lib.messages);
});
