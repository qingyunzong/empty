import test from 'node:test';
import assert from 'node:assert/strict';
import { WindowAgg, invalidateAt } from '../src/windows.js';
import { parse } from '../src/expr.js';

const sumNode = parse('sum(v) over w');
const avgNode = parse('avg(v) over w');
const countNode = parse('count(v) over w');
const minNode = parse('min(v) over w');
const maxNode = parse('max(v) over w');

function makeAgg(obsList, def) {
  const caches = { buckets: {}, queries: {} };
  const agg = new WindowAgg({ w: def }, () => obsList, (obs) => ({ ...obs.metrics }), caches);
  return { agg, caches };
}

const boundaryObs = [
  { key: 'a', ts: 0, metrics: { v: 1 } },
  { key: 'b', ts: 50, metrics: { v: 10 } },
  { key: 'c', ts: 100, metrics: { v: 100 } },
];

const def = (bounds) => ({ name: 'w', size: 100, hop: 10, bounds });

test('bounds [) includes start, excludes end', () => {
  const { agg } = makeAgg(boundaryObs, def('[)'));
  const { value, windowKey } = agg.aggregate('w', sumNode, 100);
  assert.equal(value, 11);
  assert.equal(windowKey, 'w:0:100:[)');
});

test('bounds (] excludes start, includes end', () => {
  const { agg } = makeAgg(boundaryObs, def('(]'));
  assert.equal(agg.aggregate('w', sumNode, 100).value, 110);
});

test('bounds [] includes both ends', () => {
  const { agg } = makeAgg(boundaryObs, def('[]'));
  assert.equal(agg.aggregate('w', sumNode, 100).value, 111);
});

test('bounds () excludes both ends', () => {
  const { agg } = makeAgg(boundaryObs, def('()'));
  assert.equal(agg.aggregate('w', sumNode, 100).value, 10);
});

test('empty window: avg/sum/min/max are NULL, count is 0', () => {
  const { agg } = makeAgg([{ key: 'x', ts: 1000, metrics: { v: 5 } }], def('(]'));
  assert.equal(agg.aggregate('w', avgNode, 100).value, null);
  assert.equal(agg.aggregate('w', sumNode, 100).value, null);
  assert.equal(agg.aggregate('w', minNode, 100).value, null);
  assert.equal(agg.aggregate('w', maxNode, 100).value, null);
  assert.equal(agg.aggregate('w', countNode, 100).value, 0);
});

test('aggregates skip NULL metric values', () => {
  const obs = [
    { key: 'a', ts: 10, metrics: { v: 2 } },
    { key: 'b', ts: 20, metrics: {} },
    { key: 'c', ts: 30, metrics: { v: 4 } },
  ];
  const { agg } = makeAgg(obs, def('(]'));
  assert.equal(agg.aggregate('w', avgNode, 100).value, 3);
  assert.equal(agg.aggregate('w', countNode, 100).value, 2);
  assert.equal(agg.aggregate('w', minNode, 100).value, 2);
  assert.equal(agg.aggregate('w', maxNode, 100).value, 4);
});

test('correction invalidates only overlapping buckets and cached windows', () => {
  const obs = [];
  for (let t = 55; t <= 145; t += 5) obs.push({ key: `k${t}`, ts: t, metrics: { v: 1 } });
  const d = def('(]');
  const { agg, caches } = makeAgg(obs, d);
  agg.aggregate('w', avgNode, 150); // window (50,150] -> interior buckets 6..13
  agg.aggregate('w', avgNode, 350); // window (250,350] -> interior buckets 26..33
  const bucketKeys = Object.keys(caches.buckets.w);
  for (const b of ['6', '10', '13', '26', '33']) assert.ok(bucketKeys.includes(b), `bucket ${b} cached`);
  assert.equal(Object.keys(caches.queries).length, 2);

  invalidateAt(caches, { w: d }, 100); // simulate correction of an observation at ts=100

  assert.ok(!caches.buckets.w['10'], 'overlapping bucket invalidated');
  assert.ok(caches.buckets.w['6'], 'non-overlapping bucket retained');
  assert.ok(caches.buckets.w['26'], 'far bucket retained');
  assert.deepEqual(Object.keys(caches.queries), ['w:250:350:(]'], 'only overlapping window query invalidated');
});

test('recomputed value after invalidation reflects corrected data', () => {
  const obs = [
    { key: 'a', ts: 10, metrics: { v: 10 } },
    { key: 'b', ts: 20, metrics: { v: 20 } },
  ];
  const d = def('(]');
  const caches = { buckets: {}, queries: {} };
  const agg = new WindowAgg({ w: d }, () => obs, (o) => ({ ...o.metrics }), caches);
  assert.equal(agg.aggregate('w', sumNode, 100).value, 30);
  obs[0].metrics.v = 100; // correction
  invalidateAt(caches, { w: d }, 10);
  assert.equal(agg.aggregate('w', sumNode, 100).value, 120);
});
