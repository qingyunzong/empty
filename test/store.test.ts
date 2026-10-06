import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Table,
  UniqueConstraintError,
  Delta,
} from '../src/store.js';

function makeUsers(): Table {
  return new Table('users', [
    { name: 'byEmail', field: 'email', unique: true },
    { name: 'byCity', field: 'city' },
  ]);
}

test('indexes map field values to row ids', () => {
  const users = makeUsers();
  let alice = 0;
  let bob = 0;
  users.transaction((tx) => {
    alice = tx.insert({ email: 'alice@x.dev', city: 'Berlin' });
    bob = tx.insert({ email: 'bob@x.dev', city: 'Berlin' });
  });

  assert.deepEqual(users.findBy('byEmail', 'alice@x.dev'), [alice]);
  assert.deepEqual(users.findBy('byEmail', 'nobody@x.dev'), []);
  assert.deepEqual(new Set(users.findBy('byCity', 'Berlin')), new Set([alice, bob]));

  users.transaction((tx) => tx.update(bob, { city: 'Paris' }));
  assert.deepEqual(users.findBy('byCity', 'Berlin'), [alice]);
  assert.deepEqual(users.findBy('byCity', 'Paris'), [bob]);

  users.transaction((tx) => tx.delete(alice));
  assert.deepEqual(users.findBy('byEmail', 'alice@x.dev'), []);
  assert.deepEqual(users.findBy('byCity', 'Berlin'), []);
});

test('multiple writes to one row publish only the final delta', () => {
  const users = makeUsers();
  const published: Delta[] = [];
  users.subscribe((delta) => published.push(delta));

  let id = 0;
  users.transaction((tx) => {
    id = tx.insert({ email: 'a@x.dev', city: 'Rome' });
  });
  published.length = 0;

  const delta = users.transaction((tx) => {
    tx.update(id, { city: 'Milan' });
    tx.update(id, { city: 'Turin' });
    tx.update(id, { email: 'b@x.dev' });
    tx.update(id, { city: 'Naples' });
  });

  assert.equal(published.length, 1, 'exactly one notification');
  assert.equal(delta.length, 1, 'one coalesced change for the row');
  const change = delta[0]!;
  assert.equal(change.type, 'update');
  assert.equal(change.id, id);
  assert.deepEqual(change.before, { email: 'a@x.dev', city: 'Rome' });
  assert.deepEqual(change.after, { email: 'b@x.dev', city: 'Naples' });
  assert.deepEqual(new Set(change.changedFields), new Set(['email', 'city']));
  assert.deepEqual(published[0], delta);
});

test('insert then delete of the same row in one batch publishes nothing', () => {
  const users = makeUsers();
  let notifications = 0;
  users.subscribe(() => notifications++);

  const delta = users.transaction((tx) => {
    const id = tx.insert({ email: 'ghost@x.dev', city: 'Nowhere' });
    tx.update(id, { city: 'Somewhere' });
    tx.delete(id);
  });

  assert.equal(delta.length, 0);
  assert.equal(notifications, 0);
  assert.equal(users.size, 0);
});

test('no-op update publishes nothing', () => {
  const users = makeUsers();
  let id = 0;
  users.transaction((tx) => {
    id = tx.insert({ email: 'a@x.dev', city: 'Rome' });
  });
  let notifications = 0;
  users.subscribe(() => notifications++);
  const delta = users.transaction((tx) => tx.update(id, { city: 'Rome' }));
  assert.equal(delta.length, 0);
  assert.equal(notifications, 0);
});

test('unique index allows key swap within one batch', () => {
  const users = makeUsers();
  let a = 0;
  let b = 0;
  users.transaction((tx) => {
    a = tx.insert({ email: 'a@x.dev', city: 'Rome' });
    b = tx.insert({ email: 'b@x.dev', city: 'Milan' });
  });

  const delta = users.transaction((tx) => {
    tx.update(a, { email: 'b@x.dev' });
    tx.update(b, { email: 'a@x.dev' });
  });

  assert.equal(delta.length, 2);
  assert.deepEqual(users.findBy('byEmail', 'a@x.dev'), [b]);
  assert.deepEqual(users.findBy('byEmail', 'b@x.dev'), [a]);
  assert.equal(users.get(a)!.email, 'b@x.dev');
  assert.equal(users.get(b)!.email, 'a@x.dev');
});

test('unique conflict rolls the whole transaction back', () => {
  const users = makeUsers();
  let a = 0;
  let b = 0;
  users.transaction((tx) => {
    a = tx.insert({ email: 'a@x.dev', city: 'Rome' });
    b = tx.insert({ email: 'b@x.dev', city: 'Milan' });
  });

  let notifications = 0;
  users.subscribe(() => notifications++);

  assert.throws(
    () =>
      users.transaction((tx) => {
        tx.update(a, { email: 'b@x.dev', city: 'CHANGED' }); // conflicts with b
        tx.insert({ email: 'c@x.dev', city: 'Paris' }); // must be rolled back too
      }),
    UniqueConstraintError,
  );

  assert.equal(notifications, 0, 'no notification for a failed commit');
  assert.equal(users.size, 2, 'no partial inserts');
  assert.deepEqual(users.get(a), { email: 'a@x.dev', city: 'Rome' });
  assert.deepEqual(users.findBy('byEmail', 'a@x.dev'), [a]);
  assert.deepEqual(users.findBy('byEmail', 'b@x.dev'), [b]);
  assert.deepEqual(users.findBy('byCity', 'CHANGED'), []);
  assert.deepEqual(users.findBy('byCity', 'Paris'), []);
});

test('duplicate unique keys staged inside one batch are rejected', () => {
  const users = makeUsers();
  users.transaction((tx) => {
    tx.insert({ email: 'a@x.dev', city: 'Rome' });
  });
  assert.throws(
    () =>
      users.transaction((tx) => {
        tx.insert({ email: 'dup@x.dev', city: 'A' });
        tx.insert({ email: 'dup@x.dev', city: 'B' });
      }),
    UniqueConstraintError,
  );
  assert.equal(users.size, 1);
});

test('exception inside the transaction callback rolls everything back', () => {
  const users = makeUsers();
  let id = 0;
  users.transaction((tx) => {
    id = tx.insert({ email: 'a@x.dev', city: 'Rome' });
  });
  assert.throws(() =>
    users.transaction((tx) => {
      tx.update(id, { city: 'LOST' });
      throw new Error('boom');
    }),
  );
  assert.equal(users.get(id)!.city, 'Rome');
  assert.deepEqual(users.findBy('byCity', 'LOST'), []);
});

test('subscribers run after commit and see committed state', () => {
  const users = makeUsers();
  const seen: unknown[] = [];
  let id = 0;
  users.subscribe((delta, table) => {
    for (const change of delta) {
      seen.push(table.get(change.id)?.city ?? null);
    }
  });
  users.transaction((tx) => {
    id = tx.insert({ email: 'a@x.dev', city: 'Rome' });
    // Not yet committed: outside readers must not see it.
    assert.equal(users.size, 0);
  });
  assert.deepEqual(seen, ['Rome'], 'subscriber observed post-commit state');
  assert.equal(users.get(id)!.city, 'Rome');
});

test('subscribers are reentrant: nested transactions commit and notify', () => {
  const users = makeUsers();
  const log: string[] = [];
  let depth = 0;

  users.subscribe((delta, table) => {
    for (const change of delta) {
      log.push(`d${depth}:${change.type}#${change.id}:${String(change.after?.city ?? '-')}`);
    }
    if (depth === 0) {
      depth++;
      try {
        // Re-enter: start and commit a nested transaction from the callback.
        table.transaction((tx) => tx.insert({ email: 'nested@x.dev', city: 'Nested' }));
      } finally {
        depth--;
      }
    }
  });

  users.transaction((tx) => tx.insert({ email: 'root@x.dev', city: 'Root' }));

  assert.equal(log.length, 2);
  assert.equal(log[0], 'd0:insert#1:Root');
  assert.equal(log[1], 'd1:insert#2:Nested');
  assert.equal(users.size, 2);
  assert.deepEqual(users.findBy('byEmail', 'nested@x.dev'), [2]);
});

test('unsubscribe stops notifications', () => {
  const users = makeUsers();
  let count = 0;
  const off = users.subscribe(() => count++);
  users.transaction((tx) => tx.insert({ email: 'a@x.dev', city: 'Rome' }));
  off();
  users.transaction((tx) => tx.insert({ email: 'b@x.dev', city: 'Milan' }));
  assert.equal(count, 1);
});
