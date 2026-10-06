import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Table } from '../src/store.js';
import { replicate, verifyIndexModel, verifyReplica } from '../src/replicate.js';

const SPECS = [
  { name: 'byEmail', field: 'email', unique: true },
  { name: 'byCity', field: 'city' },
];

function makePair(): { source: Table; replica: Table } {
  return { source: new Table('users', SPECS), replica: new Table('users-copy', SPECS) };
}

test('replica mirrors initial state and all committed deltas', () => {
  const { source, replica } = makePair();

  let a = 0;
  let b = 0;
  source.transaction((tx) => {
    a = tx.insert({ email: 'a@x.dev', city: 'Rome' });
    b = tx.insert({ email: 'b@x.dev', city: 'Milan' });
  });

  const stop = replicate(source, replica);
  assert.equal(replica.size, 2, 'initial sync copies existing rows');

  source.transaction((tx) => {
    tx.update(a, { email: 'b@x.dev', city: 'Turin' }); // key swap, batch-safe
    tx.update(b, { email: 'a@x.dev' });
  });
  assert.deepEqual(replica.findBy('byEmail', 'a@x.dev'), [b]);
  assert.deepEqual(replica.findBy('byEmail', 'b@x.dev'), [a]);

  source.transaction((tx) => {
    tx.insert({ email: 'c@x.dev', city: 'Paris' });
    tx.delete(b);
  });

  assert.deepEqual(replica.findBy('byEmail', 'a@x.dev'), [], 'delete mirrored');
  assert.deepEqual(replica.findBy('byEmail', 'b@x.dev'), [a]);
  assert.equal(replica.size, 2);

  const report = verifyReplica(source, replica);
  assert.ok(report.ok, report.problems.join('\n'));

  stop();
  source.transaction((tx) => tx.insert({ email: 'd@x.dev', city: 'Berlin' }));
  assert.equal(replica.size, 2, 'replication stopped after unsubscribe');
});

test('full index-model verification passes for a healthy replica', () => {
  const { source, replica } = makePair();
  replicate(source, replica);
  source.transaction((tx) => {
    tx.insert({ email: 'a@x.dev', city: 'Rome' });
    tx.insert({ email: 'b@x.dev', city: 'Rome' });
    tx.insert({ email: 'c@x.dev', city: 'Milan' });
  });

  assert.ok(verifyIndexModel(source).ok);
  assert.ok(verifyIndexModel(replica).ok);
  const report = verifyReplica(source, replica);
  assert.ok(report.ok, report.problems.join('\n'));
  assert.deepEqual(report.problems, []);
});

test('verification detects tampered replica rows', () => {
  const { source, replica } = makePair();
  replicate(source, replica);
  let id = 0;
  source.transaction((tx) => {
    id = tx.insert({ email: 'a@x.dev', city: 'Rome' });
  });
  assert.ok(verifyReplica(source, replica).ok);

  // Simulate data corruption bypassing the transactional API.
  const rows = (replica as unknown as { rows: Map<number, Record<string, unknown>> }).rows;
  rows.get(id)!.city = 'HACKED';

  const report = verifyReplica(source, replica);
  assert.equal(report.ok, false);
  assert.ok(report.problems.length > 0);
});

test('verification detects a corrupted live index', () => {
  const { source, replica } = makePair();
  replicate(source, replica);
  source.transaction((tx) => tx.insert({ email: 'a@x.dev', city: 'Rome' }));
  assert.ok(verifyIndexModel(replica).ok);

  // Corrupt the live unique index without touching rows.
  const unique = (
    replica as unknown as { uniqueIndexes: Map<string, Map<unknown, number>> }
  ).uniqueIndexes;
  unique.get('byEmail')!.delete('a@x.dev');

  const report = verifyIndexModel(replica);
  assert.equal(report.ok, false);
  assert.ok(report.problems[0]!.includes('diverges'));
});
