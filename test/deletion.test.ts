import { test } from 'node:test';
import { equal, notEqual, ok } from 'node:assert/strict';
import { planMigration, type MigrationInterval } from '../src/migration.js';
import { buildRingSync, makeRandomAdapter } from './helpers/adapters.js';

function contains(interval: MigrationInterval, hash: number): boolean {
  if (interval.from === interval.to) return true;
  if (interval.from < interval.to) return hash > interval.from && hash <= interval.to;
  return hash > interval.from || hash <= interval.to;
}

test('deleting a node migrates only the keys that belonged to it', () => {
  for (let seed = 1; seed <= 5; seed++) {
    const adapter = makeRandomAdapter(seed * 31337);
    const hashFn = (input: string) => adapter.hash(input) as number;
    const nodes = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, i) => ({ id, weight: 1 + ((seed + i) % 3) }));
    const oldRing = buildRingSync(hashFn, nodes);
    const newRing = buildRingSync(hashFn, nodes.filter((n) => n.id !== 'c'));

    const plan = planMigration(oldRing, newRing);
    ok(plan.length > 0, `seed=${seed}: deleted node should own some intervals`);
    for (const interval of plan) {
      equal(interval.src, 'c', 'every migrated interval must come from the deleted node');
      notEqual(interval.dst, 'c');
    }

    for (let k = 0; k < 1000; k++) {
      const hash = hashFn(`key-${seed}-${k}`) >>> 0;
      const before = oldRing.owner(hash);
      const after = newRing.owner(hash);
      const interval = plan.find((iv) => contains(iv, hash));
      if (before !== 'c') {
        equal(after, before, `key ${k} not owned by deleted node must not move`);
        equal(interval, undefined, 'untouched keyspace must not appear in the plan');
      } else {
        notEqual(after, 'c');
        ok(interval, `key ${k} previously on deleted node must be covered by the plan`);
        equal(interval.src, 'c');
        equal(interval.dst, after);
      }
    }
  }
});

test('deleting the last node empties the ring', () => {
  const adapter = makeRandomAdapter(1);
  const hashFn = (input: string) => adapter.hash(input) as number;
  const oldRing = buildRingSync(hashFn, [{ id: 'solo', weight: 3 }]);
  const newRing = buildRingSync(hashFn, []);
  const plan = planMigration(oldRing, newRing);
  equal(plan.length, 1);
  equal(plan[0].src, 'solo');
  equal(plan[0].dst, null);
  equal(plan[0].from, plan[0].to, 'single-point ring yields a full-circle interval');
});
