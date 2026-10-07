import { test } from 'node:test';
import { deepEqual, equal, ok } from 'node:assert/strict';
import { planMigration, type MigrationInterval } from '../src/migration.js';
import { buildRingSync, makeRandomAdapter } from './helpers/adapters.js';

function contains(interval: MigrationInterval, hash: number): boolean {
  if (interval.from === interval.to) return true;
  if (interval.from < interval.to) return hash > interval.from && hash <= interval.to;
  return hash > interval.from || hash <= interval.to;
}

test('migration plan is the exact key-interval diff between old and new rings', () => {
  for (let seed = 1; seed <= 5; seed++) {
    const adapter = makeRandomAdapter(seed * 999983);
    const hashFn = (input: string) => adapter.hash(input) as number;
    const oldNodes = [
      { id: 'a', weight: 2 },
      { id: 'b', weight: 1 },
      { id: 'c', weight: 3 },
      { id: 'd', weight: 2 },
    ];
    // Remove c, reweight d, add e: a mixed membership + weight change.
    const newNodes = [
      { id: 'a', weight: 2 },
      { id: 'b', weight: 1 },
      { id: 'd', weight: 4 },
      { id: 'e', weight: 2 },
    ];
    const oldRing = buildRingSync(hashFn, oldNodes);
    const newRing = buildRingSync(hashFn, newNodes);
    const plan = planMigration(oldRing, newRing);

    // Intervals must not overlap.
    const sorted = [...plan].sort((x, y) => x.from - y.from);
    for (let i = 1; i < sorted.length; i++) {
      ok(sorted[i - 1].to <= sorted[i].from || sorted[i].to < sorted[i - 1].from, 'intervals must not overlap');
    }

    for (let k = 0; k < 2000; k++) {
      const hash = hashFn(`key-${seed}-${k}`) >>> 0;
      const before = oldRing.owner(hash);
      const after = newRing.owner(hash);
      const interval = plan.find((iv) => contains(iv, hash));
      if (before === after) {
        equal(interval, undefined, `unchanged key ${k} must not be in the plan`);
      } else {
        ok(interval, `changed key ${k} must be covered by the plan`);
        equal(interval.src, before);
        equal(interval.dst, after);
      }
    }
  }
});

test('identical rings produce an empty plan', () => {
  const adapter = makeRandomAdapter(5);
  const hashFn = (input: string) => adapter.hash(input) as number;
  const nodes = [
    { id: 'a', weight: 2 },
    { id: 'b', weight: 3 },
  ];
  const plan = planMigration(buildRingSync(hashFn, nodes), buildRingSync(hashFn, nodes));
  deepEqual(plan, []);
});
