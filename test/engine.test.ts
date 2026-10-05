import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TableQueryEngine,
  matchAll,
  type Publication,
  type QuerySpec,
  type Row,
} from '../src/index.js';

const SPEC: QuerySpec = {
  where: [{ field: 'region', op: 'eq', value: 'eu' }],
  groupBy: 'sku',
  sum: 'amount',
  topK: 2,
};

function seed(engine: TableQueryEngine): void {
  const rows: [string, Row][] = [
    ['r1', { region: 'eu', sku: 'apple', amount: 5 }],
    ['r2', { region: 'eu', sku: 'banana', amount: 3 }],
    ['r3', { region: 'us', sku: 'apple', amount: 100 }],
    ['r4', { region: 'eu', sku: 'cherry', amount: 1 }],
  ];
  engine.applyBatch(rows.map(([id, row]) => ({ id, row })));
}

test('filter + sum-by-key + top-k with initial full scan', () => {
  const engine = new TableQueryEngine();
  seed(engine);
  const { generation, publication } = engine.registerQuery(SPEC);
  assert.equal(publication.version, 1);
  assert.deepEqual(
    publication.result.map((e) => [e.key, e.sum, e.rank]),
    [
      ['apple', 5, 1],
      ['banana', 3, 2],
    ],
  );
  // initial publication is the net diff from empty
  assert.deepEqual(
    publication.delta.map((d) => [d.key, d.change]),
    [
      ['apple', 'added'],
      ['banana', 'added'],
    ],
  );
  assert.equal(engine.read(generation).length, 2);
});

test('ties in sum are broken by key ascending', () => {
  const engine = new TableQueryEngine();
  engine.applyBatch([
    { id: 'a', row: { g: 'x', k: 'delta', v: 7 } },
    { id: 'b', row: { g: 'x', k: 'alpha', v: 7 } },
    { id: 'c', row: { g: 'x', k: 'charlie', v: 7 } },
  ]);
  const { publication } = engine.registerQuery({ groupBy: 'k', sum: 'v', topK: 2 });
  assert.deepEqual(
    publication.result.map((e) => e.key),
    ['alpha', 'charlie'],
  );
});

test('batch publishes only the net diff between old and new results', () => {
  const engine = new TableQueryEngine();
  seed(engine);
  engine.registerQuery(SPEC);
  const [pub] = engine.applyBatch([
    { id: 'r5', row: { region: 'eu', sku: 'banana', amount: 10 } }, // banana 3 -> 13
    { id: 'r6', row: { region: 'us', sku: 'cherry', amount: 50 } }, // filtered out
  ]) as [Publication];
  // only banana changed; apple untouched and absent from the delta
  assert.deepEqual(pub.delta, [
    { key: 'banana', change: 'updated', oldSum: 3, newSum: 13, oldRank: 2, newRank: 1 },
  ]);
  assert.deepEqual(
    pub.result.map((e) => [e.key, e.sum]),
    [
      ['banana', 13],
      ['apple', 5],
    ],
  );
});

test('net diff reports added and removed keys around the top-k boundary', () => {
  const engine = new TableQueryEngine();
  seed(engine);
  engine.registerQuery(SPEC);
  const [pub] = engine.applyBatch([
    { id: 'r7', row: { region: 'eu', sku: 'cherry', amount: 20 } }, // cherry 1 -> 21, enters
  ]) as [Publication];
  assert.deepEqual(
    pub.delta.map((d) => [d.key, d.change]),
    [
      ['banana', 'removed'],
      ['cherry', 'added'],
    ],
  );
  assert.deepEqual(
    pub.result.map((e) => e.key),
    ['cherry', 'apple'],
  );
});

test('deletes shrink groups and empty groups disappear', () => {
  const engine = new TableQueryEngine();
  seed(engine);
  engine.registerQuery(SPEC);
  const [pub] = engine.applyBatch([{ id: 'r1' }, { id: 'r2' }]) as [Publication];
  assert.deepEqual(
    pub.delta.map((d) => [d.key, d.change]),
    [
      ['apple', 'removed'],
      ['banana', 'removed'],
      ['cherry', 'added'],
    ],
  );
  assert.deepEqual(
    pub.result.map((e) => [e.key, e.sum]),
    [['cherry', 1]],
  );
});

test('row moving in and out of the filter updates sums correctly', () => {
  const engine = new TableQueryEngine();
  seed(engine);
  engine.registerQuery(SPEC);
  const [pub] = engine.applyBatch([
    { id: 'r3', row: { region: 'eu', sku: 'apple', amount: 100 } }, // us -> eu
    { id: 'r4', row: { region: 'us', sku: 'cherry', amount: 1 } }, // eu -> us
  ]) as [Publication];
  assert.deepEqual(
    pub.delta.map((d) => [d.key, d.change, d.newSum]),
    [['apple', 'updated', 105]],
  );
  assert.deepEqual(
    pub.result.map((e) => [e.key, e.sum]),
    [
      ['apple', 105],
      ['banana', 3],
    ],
  );
});

test('subscribers read their pinned version across later batches', () => {
  const engine = new TableQueryEngine();
  seed(engine);
  const { generation } = engine.registerQuery(SPEC);
  const token = engine.subscribe(generation);
  engine.applyBatch([{ id: 'r8', row: { region: 'eu', sku: 'banana', amount: 50 } }]);
  engine.applyBatch([{ id: 'r9', row: { region: 'eu', sku: 'apple', amount: 50 } }]);
  const pinned = engine.readSubscriber(token);
  assert.equal(pinned.version, 1);
  assert.deepEqual(
    pinned.result.map((e) => [e.key, e.sum]),
    [
      ['apple', 5],
      ['banana', 3],
    ],
  );
  // latest moved on
  assert.deepEqual(
    engine.read(generation).map((e) => [e.key, e.sum]),
    [
      ['apple', 55],
      ['banana', 53],
    ],
  );
  engine.unsubscribe(token);
  assert.throws(() => engine.readSubscriber(token), /unknown subscriber/);
});

test('changing conditions or parameters yields a new generation', () => {
  const engine = new TableQueryEngine();
  seed(engine);
  const g1 = engine.registerQuery(SPEC).generation;
  const g1again = engine.registerQuery({ ...SPEC, where: [...(SPEC.where ?? [])] }).generation;
  const gTopK = engine.registerQuery({ ...SPEC, topK: 3 }).generation;
  const gCond = engine.registerQuery({
    ...SPEC,
    where: [{ field: 'region', op: 'eq', value: 'us' }],
  }).generation;
  assert.equal(g1, g1again, 'identical spec reuses the generation');
  assert.notEqual(g1, gTopK, 'topK change is a new generation');
  assert.notEqual(g1, gCond, 'condition change is a new generation');
  // the new generation has its own independent state and version line
  const us = engine.read(gCond);
  assert.deepEqual(
    us.map((e) => [e.key, e.sum]),
    [['apple', 100]],
  );
});

test('every batch is checked against a full scan (randomized, 300 batches)', () => {
  const engine = new TableQueryEngine();
  const spec: QuerySpec = {
    where: [
      { field: 'kind', op: 'in', value: ['a', 'b'] },
      { field: 'qty', op: 'gte', value: 0 },
    ],
    groupBy: 'k',
    sum: 'qty',
    topK: 4,
  };
  const { generation } = engine.registerQuery(spec);
  let random = 123456789;
  const rand = (): number => {
    random ^= random << 13;
    random ^= random >>> 17;
    random ^= random << 5;
    return (random >>> 0) / 2 ** 32;
  };
  const mirror = new Map<string, Row>();
  const keys = ['k1', 'k2', 'k3', 'k4', 'k5', 'k6'];
  const kinds = ['a', 'b', 'c'];
  let version = 1;
  for (let batch = 0; batch < 300; batch++) {
    const ops = [];
    const n = 1 + Math.floor(rand() * 5);
    for (let i = 0; i < n; i++) {
      const id = `row${Math.floor(rand() * 40)}`;
      if (rand() < 0.25) {
        ops.push({ id });
      } else {
        ops.push({
          id,
          row: {
            kind: kinds[Math.floor(rand() * kinds.length)] as string,
            k: keys[Math.floor(rand() * keys.length)] as string,
            qty: Math.floor(rand() * 20) - 5,
          },
        });
      }
    }
    for (const op of ops) {
      if (op.row === undefined) mirror.delete(op.id);
      else mirror.set(op.id, op.row);
    }
    const [pub] = engine.applyBatch(ops) as [Publication];
    version += 1;
    assert.equal(pub.version, version);
    // check the publication against an independent full scan of the mirror
    const expected = fullScan(spec, [...mirror.values()]);
    assert.deepEqual(
      pub.result.map((e) => [e.key, e.sum, e.rank]),
      expected.map((e) => [e.key, e.sum, e.rank]),
      `batch ${batch}`,
    );
  }
  assert.equal(engine.currentVersion(generation), version);
});

function fullScan(
  spec: QuerySpec,
  rows: Row[],
): { key: string; sum: number; rank: number }[] {
  const sums = new Map<string, number>();
  for (const row of rows) {
    if (!matchAll(row, spec.where)) continue;
    const key = String(row[spec.groupBy]);
    sums.set(key, (sums.get(key) ?? 0) + Number(row[spec.sum]));
  }
  return [...sums.entries()]
    .map(([key, sum]) => ({ key, sum, rank: 0 }))
    .sort((a, b) => (a.sum !== b.sum ? b.sum - a.sum : a.key < b.key ? -1 : 1))
    .slice(0, spec.topK)
    .map((e, i) => ({ ...e, rank: i + 1 }));
}
