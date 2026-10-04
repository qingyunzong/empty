import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { IntervalSet, RecallError } from '../src/intervals.js';
import { Store } from '../src/store.js';
import { traceRecall, referenceRecall } from '../src/recall.js';
import { parseUtc } from '../src/timeutil.js';
import { runOps } from '../src/engine.js';

const recorded = [];
function record(label, data) {
  recorded.push({ label, data });
}

after(() => {
  const lines = recorded.map(
    (r) => `=== ${r.label} ===\n${JSON.stringify(r.data, null, 2)}`,
  );
  writeFileSync(
    new URL('../test-results.txt', import.meta.url),
    `recall-trace real test results\n${lines.join('\n\n')}\n`,
  );
});

const UTC8 = [{ local: '2026-01-01T00:00:00', utc: '2025-12-31T16:00:00Z' }];
const UTC0 = [{ local: '2026-01-01T00:00:00', utc: '2026-01-01T00:00:00Z' }];

const DAY = 24 * 3600 * 1000;
const HOUR = 3600 * 1000;

function batch(id, localStart, localEnd, shelfLifeMs, packagingMs, conversion = UTC8) {
  return { id, localStart, localEnd, shelfLifeMs, packagingMs, conversion };
}

function makeStore(batches, records) {
  const store = new Store();
  for (const b of batches) store.addBatch(b);
  for (const r of records) store.addRecord(r);
  return store;
}

function recall(store, defect, start, end, snapshot = null) {
  return traceRecall(store, defect, parseUtc(start), parseUtc(end), snapshot);
}

function normalized(results) {
  return results
    .map((r) => ({ ...r, pathKey: r.path.map((p) => `${p.record}#${p.version}`).join('>') }))
    .sort((a, b) => (a.product + a.pathKey).localeCompare(b.product + b.pathKey))
    .map(({ pathKey, ...rest }) => rest);
}

function assertMatchesReference(store, defect, start, end, snapshot = null) {
  const main = traceRecall(store, defect, parseUtc(start), parseUtc(end), snapshot);
  const ref = referenceRecall(store, defect, parseUtc(start), parseUtc(end), snapshot);
  assert.deepStrictEqual(normalized(main), normalized(ref));
  return main;
}

test('interval set: union/intersect/difference, half-open semantics', () => {
  const a = IntervalSet.of(0, 5);
  const b = IntervalSet.of(5, 10);
  assert.deepStrictEqual(a.union(b).intervals, [[0, 10]]);
  assert.deepStrictEqual(a.intersect(b).intervals, []);
  assert.equal(a.overlaps(b), false);

  const c = IntervalSet.of(4, 6);
  assert.deepStrictEqual(a.intersect(c).intervals, [[4, 5]]);
  assert.deepStrictEqual(IntervalSet.of(0, 10).difference(IntervalSet.of(3, 5)).intervals, [[0, 3], [5, 10]]);
  assert.deepStrictEqual(
    new IntervalSet([[0, 3], [7, 9]]).union(new IntervalSet([[2, 8]])).intervals,
    [[0, 9]],
  );
  assert.deepStrictEqual(
    new IntervalSet([[0, 10]]).difference(new IntervalSet([[0, 4], [6, 10]])).intervals,
    [[4, 6]],
  );
  record('interval-set-ops', {
    union: a.union(b).intervals,
    touchIntersect: a.intersect(b).intervals,
    difference: IntervalSet.of(0, 10).difference(IntervalSet.of(3, 5)).intervals,
  });
});

test('acceptance 1: three-layer converging genealogy, partial shelf-life hits', () => {
  const batches = [
    batch('C', '2026-03-01T08:00:00', '2026-03-01T10:00:00', 2 * DAY, 4 * HOUR),
    batch('M1', '2026-03-02T08:00:00', '2026-03-02T10:00:00', 10 * DAY, DAY),
    batch('M2', '2026-03-03T08:00:00', '2026-03-03T10:00:00', 10 * DAY, DAY),
    batch('F1', '2026-03-04T08:00:00', '2026-03-04T10:00:00', 5 * DAY, 4 * DAY),
    batch('F2', '2026-03-05T08:00:00', '2026-03-05T10:00:00', 6 * DAY, DAY),
    batch('F3', '2026-03-06T08:00:00', '2026-03-06T10:00:00', DAY, DAY),
  ];
  const records = [
    { id: 'R1', parent: 'C', child: 'M1' },
    { id: 'R2', parent: 'C', child: 'M2' },
    { id: 'R3', parent: 'M1', child: 'F1' },
    { id: 'R4', parent: 'M1', child: 'F2' },
    { id: 'R5', parent: 'M2', child: 'F2' },
    { id: 'R6', parent: 'M2', child: 'F3' },
  ];
  const store = makeStore(batches, records);
  const obsStart = '2026-03-08T00:00:00Z';
  const obsEnd = '2026-03-10T00:00:00Z';
  const results = assertMatchesReference(store, 'C', obsStart, obsEnd);
  record('acceptance-1-three-layer-converging', results);

  assert.equal(results.length, 3);
  const byProduct = new Map();
  for (const r of results) {
    if (!byProduct.has(r.product)) byProduct.set(r.product, []);
    byProduct.get(r.product).push(r);
  }
  assert.deepStrictEqual([...byProduct.keys()].sort(), ['F1', 'F2']);
  assert.equal(byProduct.get('F2').length, 2);

  const f1 = byProduct.get('F1')[0];
  assert.deepStrictEqual(f1.hitInterval, [['2026-03-08T00:00:00.000Z', '2026-03-09T02:00:00.000Z']]);
  assert.deepStrictEqual(f1.path.map((p) => p.record), ['R1', 'R3']);
  assert.equal(f1.inPackaging, true);
  assert.deepStrictEqual(f1.packagingHitInterval, [['2026-03-08T00:00:00.000Z', '2026-03-08T02:00:00.000Z']]);

  for (const f2 of byProduct.get('F2')) {
    assert.deepStrictEqual(f2.hitInterval, [['2026-03-08T00:00:00.000Z', '2026-03-10T00:00:00.000Z']]);
    assert.equal(f2.inPackaging, false);
  }
  const f2paths = byProduct.get('F2').map((r) => r.path.map((p) => p.record).join('>')).sort();
  assert.deepStrictEqual(f2paths, ['R1>R4', 'R2>R5']);
});

test('acceptance 2: endpoint touch excluded, one-millisecond crossing hits', () => {
  const batches = [
    batch('C', '2026-03-09T00:00:00', '2026-03-09T01:00:00', DAY, DAY, UTC0),
    batch('F', '2026-03-09T02:00:00', '2026-03-10T00:00:00', 1000, 2000, UTC0),
  ];
  const store = makeStore(batches, [{ id: 'R1', parent: 'C', child: 'F' }]);

  const touch = assertMatchesReference(store, 'C', '2026-03-10T00:00:01.000Z', '2026-03-10T00:00:02.000Z');
  record('acceptance-2-endpoint-touch', touch);
  assert.equal(touch.length, 0);

  const cross = assertMatchesReference(store, 'C', '2026-03-10T00:00:00.999Z', '2026-03-10T00:00:02.000Z');
  record('acceptance-2-one-ms-crossing', cross);
  assert.equal(cross.length, 1);
  assert.deepStrictEqual(cross[0].hitInterval, [['2026-03-10T00:00:00.999Z', '2026-03-10T00:00:01.000Z']]);
  assert.equal(cross[0].inPackaging, true);
  assert.deepStrictEqual(cross[0].packagingHitInterval, [['2026-03-10T00:00:00.999Z', '2026-03-10T00:00:02.000Z']]);
});

test('acceptance 3: snapshot rollback keeps old and new results coexisting', () => {
  const batches = [
    batch('C', '2026-03-01T08:00:00', '2026-03-01T10:00:00', 2 * DAY, 4 * HOUR),
    batch('M', '2026-03-02T08:00:00', '2026-03-02T10:00:00', 10 * DAY, DAY),
    batch('F1', '2026-03-03T08:00:00', '2026-03-03T10:00:00', 30 * DAY, DAY),
    batch('F2', '2026-03-04T08:00:00', '2026-03-04T10:00:00', 30 * DAY, DAY),
  ];
  const store = makeStore(batches, [
    { id: 'R1', parent: 'C', child: 'M' },
    { id: 'R2', parent: 'M', child: 'F1' },
  ]);
  const obsStart = '2026-03-10T00:00:00Z';
  const obsEnd = '2026-03-12T00:00:00Z';

  store.snapshot('v1');
  const before = assertMatchesReference(store, 'C', obsStart, obsEnd);
  assert.deepStrictEqual(before.map((r) => r.product), ['F1']);
  assert.deepStrictEqual(before[0].path.map((p) => `${p.record}#${p.version}`), ['R1#1', 'R2#1']);

  store.correctRecord({ id: 'R2', parent: 'M', child: 'F2' });
  store.snapshot('v2');
  const afterCorrection = assertMatchesReference(store, 'C', obsStart, obsEnd);
  assert.deepStrictEqual(afterCorrection.map((r) => r.product), ['F2']);
  assert.deepStrictEqual(afterCorrection[0].path.map((p) => `${p.record}#${p.version}`), ['R1#1', 'R2#2']);

  store.rollback('v1');
  const rolledBack = assertMatchesReference(store, 'C', obsStart, obsEnd);
  assert.deepStrictEqual(rolledBack, before);

  const snapV1 = assertMatchesReference(store, 'C', obsStart, obsEnd, 'v1');
  const snapV2 = assertMatchesReference(store, 'C', obsStart, obsEnd, 'v2');
  assert.deepStrictEqual(snapV1, before);
  assert.deepStrictEqual(snapV2, afterCorrection);

  record('acceptance-3-snapshot-v1-results', snapV1);
  record('acceptance-3-snapshot-v2-results', snapV2);
  record('acceptance-3-after-rollback-current', rolledBack);

  assert.throws(() => store.rollback('nope'), (e) => e instanceof RecallError && e.code === 'UNKNOWN_SNAPSHOT');
  assert.throws(
    () => traceRecall(store, 'C', parseUtc(obsStart), parseUtc(obsEnd), 'nope'),
    (e) => e.code === 'UNKNOWN_SNAPSHOT',
  );
});

test('errors: reversed interval, negative shelf life, unknown snapshot/batch', () => {
  const store = new Store();
  assert.throws(
    () => store.addBatch(batch('B', '2026-03-02T00:00:00', '2026-03-01T00:00:00', DAY, DAY)),
    (e) => e.code === 'REVERSED_INTERVAL',
  );
  assert.throws(
    () => store.addBatch(batch('B', '2026-03-01T00:00:00', '2026-03-02T00:00:00', -1, DAY)),
    (e) => e.code === 'NEGATIVE_SHELF_LIFE',
  );
  store.addBatch(batch('B', '2026-03-01T00:00:00', '2026-03-02T00:00:00', DAY, DAY));
  assert.throws(
    () => traceRecall(store, 'B', parseUtc('2026-03-05T00:00:00Z'), parseUtc('2026-03-04T00:00:00Z')),
    (e) => e.code === 'REVERSED_INTERVAL',
  );
  assert.throws(
    () => traceRecall(store, 'GHOST', parseUtc('2026-03-04T00:00:00Z'), parseUtc('2026-03-05T00:00:00Z')),
    (e) => e.code === 'UNKNOWN_BATCH',
  );
  record('error-cases', {
    reversedBatch: 'REVERSED_INTERVAL',
    negativeShelfLife: 'NEGATIVE_SHELF_LIFE',
    reversedObservation: 'REVERSED_INTERVAL',
    unknownBatch: 'UNKNOWN_BATCH',
    unknownSnapshot: 'UNKNOWN_SNAPSHOT',
  });
});

test('cli engine: JSON ops in, JSON results out, per-op errors', () => {
  const input = {
    ops: [
      { op: 'addBatch', id: 'C', localStart: '2026-03-01T00:00:00', localEnd: '2026-03-01T01:00:00', shelfLifeMs: DAY, packagingMs: HOUR, conversion: UTC0 },
      { op: 'addBatch', id: 'F', localStart: '2026-03-02T00:00:00', localEnd: '2026-03-02T01:00:00', shelfLifeMs: 3 * DAY, packagingMs: DAY, conversion: UTC0 },
      { op: 'addRecord', id: 'R1', parent: 'C', child: 'F' },
      { op: 'snapshot', name: 's1' },
      { op: 'recall', defect: 'C', observeStart: '2026-03-03T00:00:00Z', observeEnd: '2026-03-04T00:00:00Z' },
      { op: 'recall', defect: 'C', observeStart: '2026-03-03T00:00:00Z', observeEnd: '2026-03-04T00:00:00Z', snapshot: 'missing' },
    ],
  };
  const outputs = runOps(input.ops);
  record('cli-engine-run', { outputs });
  assert.equal(outputs.length, 6);
  assert.equal(outputs[4].ok, true);
  assert.equal(outputs[4].results.length, 1);
  assert.equal(outputs[4].results[0].product, 'F');
  assert.deepStrictEqual(outputs[4].results[0].hitInterval, [['2026-03-03T00:00:00.000Z', '2026-03-04T00:00:00.000Z']]);
  assert.deepStrictEqual(outputs[4].results[0].path, [{ record: 'R1', version: 1, parent: 'C', child: 'F' }]);
  assert.equal(outputs[5].ok, false);
  assert.equal(outputs[5].error.code, 'UNKNOWN_SNAPSHOT');

  const clean = runOps(input.ops.slice(0, 5));
  assert.equal(clean.every((o) => o.ok), true);
});
