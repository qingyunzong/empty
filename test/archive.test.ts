import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Archive } from '../src/archive.js';
import { Client } from '../src/client.js';
import type { ArchiveEvent } from '../src/events.js';

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const rest = items.slice(0, i).concat(items.slice(i + 1));
    for (const tail of permutations(rest)) out.push([items[i] as T, ...tail]);
  }
  return out;
}

test('delete creates a tombstone; updates that never observed it do not restore the doc', () => {
  const alice = new Client('alice', new Archive());
  const bob = new Client('bob', new Archive());

  alice.update('spec', 'v1');
  bob.archive.merge(alice.archive);
  const stale = bob.update('spec', 'stale-edit'); // never observes the delete below
  const del = alice.delete('spec');

  const replica = new Archive();
  replica.merge(alice.archive);
  assert.equal(replica.state('spec').status, 'deleted');
  assert.deepEqual(replica.state('spec').liveDeletes, [del.id]);

  // The stale update arrives after the delete: content is recorded, liveness unchanged.
  replica.apply(stale);
  assert.equal(replica.state('spec').status, 'deleted');
  assert.deepEqual(replica.state('spec').liveDeletes, [del.id]);
  assert.deepEqual(replica.state('spec').branches, [
    { updateId: stale.id, content: 'stale-edit' },
  ]);
});

test('restore must reference the specific deletion version', () => {
  const alice = new Client('alice', new Archive());
  alice.update('spec', 'v1');
  const del = alice.delete('spec');

  const wrong = new Client('carol', new Archive());
  wrong.archive.merge(alice.archive);
  wrong.restore('spec', 'alice:999'); // bogus reference: cancels nothing
  assert.equal(wrong.archive.state('spec').status, 'deleted');
  assert.deepEqual(wrong.archive.state('spec').liveDeletes, [del.id]);

  wrong.restore('spec', del.id); // exact reference: cancels the tombstone
  assert.equal(wrong.archive.state('spec').status, 'active');
  assert.deepEqual(wrong.archive.state('spec').liveDeletes, []);
  assert.deepEqual(wrong.archive.state('spec').restoredDeletes, [del.id]);
});

test('concurrent deletes are independent versions and each needs its own restore', () => {
  const alice = new Client('alice', new Archive());
  const bob = new Client('bob', new Archive());
  alice.update('spec', 'v1');
  bob.archive.merge(alice.archive);

  const delA = alice.delete('spec');
  const delB = bob.delete('spec'); // concurrent with delA

  const replica = new Archive();
  replica.merge(alice.archive);
  replica.merge(bob.archive);
  assert.deepEqual(replica.state('spec').liveDeletes, [delA.id, delB.id].sort());

  // Restoring only one version leaves the other tombstone live.
  const carol = new Client('carol', replica);
  carol.restore('spec', delA.id);
  assert.equal(replica.state('spec').status, 'deleted');
  assert.deepEqual(replica.state('spec').liveDeletes, [delB.id]);

  carol.restore('spec', delB.id);
  assert.equal(replica.state('spec').status, 'active');
});

test('concurrent restores preserve content branches', () => {
  const alice = new Client('alice', new Archive());
  alice.update('doc', 'base');
  const del = alice.delete('doc');

  const bob = new Client('bob', new Archive());
  const carol = new Client('carol', new Archive());
  bob.archive.merge(alice.archive);
  carol.archive.merge(alice.archive);

  bob.restore('doc', del.id);
  carol.restore('doc', del.id); // concurrent restore of the same version
  const bHead = bob.update('doc', 'branch-B');
  const cHead = carol.update('doc', 'branch-C');

  const replica = new Archive();
  replica.merge(alice.archive);
  replica.merge(bob.archive);
  replica.merge(carol.archive);

  const state = replica.state('doc');
  assert.equal(state.status, 'active');
  assert.deepEqual(state.branches, [
    { updateId: bHead.id, content: 'branch-B' },
    { updateId: cHead.id, content: 'branch-C' },
  ]);
});

test('restore is retained when it arrives before the delete it references', () => {
  const alice = new Client('alice', new Archive());
  alice.update('spec', 'v1');
  const del = alice.delete('spec');
  const carol = new Client('carol', alice.archive);
  const restore = carol.restore('spec', del.id);

  const replica = new Archive();
  replica.apply(restore); // out of causal order: delete not yet known
  assert.equal(replica.state('spec').status, 'active'); // dangling restore cancels nothing yet
  replica.apply(del);
  assert.equal(replica.state('spec').status, 'active');
  assert.deepEqual(replica.state('spec').restoredDeletes, [del.id]);
});

test('merge is idempotent', () => {
  const alice = new Client('alice', new Archive());
  alice.update('spec', 'v1');
  const del = alice.delete('spec');
  alice.restore('spec', del.id);
  alice.update('spec', 'v2');

  const replica = new Archive();
  replica.merge(alice.archive);
  const before = replica.snapshot();
  const size = replica.size;

  assert.deepEqual(replica.merge(alice.archive), []); // nothing new
  assert.deepEqual(replica.merge(alice.archive.allEvents()), []);
  assert.deepEqual(replica.merge(replica), []); // self-merge
  for (const event of alice.archive.allEvents()) {
    assert.equal(replica.apply(event), false); // re-apply one by one
  }
  assert.equal(replica.size, size);
  assert.deepEqual(replica.snapshot(), before);
});

// Six events, 720 permutations: stale update racing a delete, then a restore.
function scenarioTombstone(): ArchiveEvent[] {
  return [
    { kind: 'update', id: 'A:1', doc: 'spec', actor: 'A', deps: [], content: 'v1' },
    { kind: 'update', id: 'B:1', doc: 'spec', actor: 'B', deps: ['A:1'], content: 'v2' },
    { kind: 'delete', id: 'A:2', doc: 'spec', actor: 'A', deps: ['A:1', 'B:1'] },
    { kind: 'update', id: 'B:2', doc: 'spec', actor: 'B', deps: ['B:1'], content: 'stale-edit' },
    { kind: 'restore', id: 'C:1', doc: 'spec', actor: 'C', deps: ['A:1', 'B:1', 'A:2', 'B:2'], restores: 'A:2' },
    { kind: 'update', id: 'C:2', doc: 'spec', actor: 'C', deps: ['B:2', 'C:1'], content: 'v3' },
  ];
}

// Six events, 720 permutations: two concurrent restores with diverging content.
function scenarioBranches(): ArchiveEvent[] {
  return [
    { kind: 'update', id: 'A:1', doc: 'doc', actor: 'A', deps: [], content: 'base' },
    { kind: 'delete', id: 'A:2', doc: 'doc', actor: 'A', deps: ['A:1'] },
    { kind: 'restore', id: 'B:1', doc: 'doc', actor: 'B', deps: ['A:1', 'A:2'], restores: 'A:2' },
    { kind: 'restore', id: 'C:1', doc: 'doc', actor: 'C', deps: ['A:1', 'A:2'], restores: 'A:2' },
    { kind: 'update', id: 'B:2', doc: 'doc', actor: 'B', deps: ['A:1', 'B:1'], content: 'branch-B' },
    { kind: 'update', id: 'C:2', doc: 'doc', actor: 'C', deps: ['A:1', 'C:1'], content: 'branch-C' },
  ];
}

function checkAllOrders(name: string, events: ArchiveEvent[], expected: Archive['snapshot'] extends () => infer R ? R : never) {
  test(name, () => {
    const orders = permutations(events);
    assert.equal(orders.length, 720);
    for (const order of orders) {
      const replica = new Archive();
      for (const event of order) replica.apply(event);
      assert.deepEqual(replica.snapshot(), expected);
      // Re-merging the full log must be a no-op regardless of delivery order.
      assert.deepEqual(replica.merge(events), []);
      assert.deepEqual(replica.snapshot(), expected);
    }
  });
}

checkAllOrders(
  'all 720 reorderings converge: tombstone cancelled, stale update harmless, provenance intact',
  scenarioTombstone(),
  {
    spec: {
      status: 'active',
      liveDeletes: [],
      restoredDeletes: ['A:2'],
      branches: [{ updateId: 'C:2', content: 'v3' }],
    },
  },
);

checkAllOrders(
  'all 720 reorderings converge: concurrent restores keep both branches',
  scenarioBranches(),
  {
    doc: {
      status: 'active',
      liveDeletes: [],
      restoredDeletes: ['A:2'],
      branches: [
        { updateId: 'B:2', content: 'branch-B' },
        { updateId: 'C:2', content: 'branch-C' },
      ],
    },
  },
);
