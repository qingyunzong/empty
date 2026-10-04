import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bisectDag,
  crossCheck,
  fullDagScan,
  topoOrder,
  type Dag,
  type Detector,
  type Status,
} from '../src/index.js';

function detectorFrom(bad: ReadonlySet<string>, throwing: ReadonlySet<string> = new Set()): Detector {
  return (version: string): Status => {
    if (throwing.has(version)) throw new Error(`probe failed for ${version}`);
    return bad.has(version) ? 'bad' : 'good';
  };
}

test('linear chain with non-monotonic results finds every first-bad boundary', async () => {
  // a good -> b bad -> c good -> d bad -> e good
  const dag: Dag = {
    nodes: ['a', 'b', 'c', 'd', 'e'],
    parents: { b: ['a'], c: ['b'], d: ['c'], e: ['d'] },
  };
  const report = await bisectDag(dag, detectorFrom(new Set(['b', 'd'])));
  assert.deepEqual(report.boundary, ['b', 'd']);
  assert.deepEqual(report.pending, []);
  assert.deepEqual(report.untested, []);
  assert.deepEqual(report.candidates, []);
  assert.equal(report.used, 5);
});

test('merge: bad version with a bad parent is not on the boundary', async () => {
  // a -> b, a -> c, {b,c} -> d ; b and d bad
  const dag: Dag = {
    nodes: ['a', 'b', 'c', 'd'],
    parents: { b: ['a'], c: ['a'], d: ['b', 'c'] },
  };
  const report = await bisectDag(dag, detectorFrom(new Set(['b', 'd'])));
  assert.deepEqual(report.boundary, ['b']);
});

test('multiple roots: a bad root is a boundary version', async () => {
  const dag: Dag = {
    nodes: ['r1', 'r2', 'x'],
    parents: { x: ['r1', 'r2'] },
  };
  const report = await bisectDag(dag, detectorFrom(new Set(['r2', 'x'])));
  assert.deepEqual(report.boundary, ['r2']);
});

test('detector exception becomes pending evidence and child stays a candidate', async () => {
  // a -> b -> c ; probe of b throws, c is bad
  const dag: Dag = {
    nodes: ['a', 'b', 'c'],
    parents: { b: ['a'], c: ['b'] },
  };
  const report = await bisectDag(dag, detectorFrom(new Set(['c']), new Set(['b'])));
  assert.deepEqual(report.boundary, []);
  assert.deepEqual(report.pending, ['b']);
  assert.deepEqual(report.candidates, ['b', 'c']);
  const failed = report.queries.find((q) => q.version === 'b');
  assert.equal(failed?.result, 'pending');
  assert.match(failed?.error ?? '', /probe failed for b/);
  assert.equal(report.queries.filter((q) => q.error !== undefined).length, 1);
});

test('budget keeps the untested set and flags unresolved candidates', async () => {
  const dag: Dag = {
    nodes: ['a', 'b', 'c', 'd', 'e'],
    parents: { b: ['a'], c: ['b'], d: ['c'], e: ['d'] },
  };
  const report = await bisectDag(dag, detectorFrom(new Set(['d'])), { budget: 3 });
  assert.equal(report.used, 3);
  assert.deepEqual(report.queries.map((q) => q.version), ['a', 'b', 'c']);
  assert.deepEqual(report.untested, ['d', 'e']);
  assert.deepEqual(report.boundary, []);
  assert.deepEqual(report.candidates, ['d', 'e']);

  const exact = await fullDagScan(dag, detectorFrom(new Set(['d'])));
  const check = crossCheck(report, exact);
  assert.equal(check.ok, true);
  assert.deepEqual(check.explainedByCandidates, ['d']);
  assert.match(check.summary, /^ok:/);
});

test('full budget cross-check confirms the exact boundary', async () => {
  const dag: Dag = {
    nodes: ['a', 'b', 'c', 'd', 'e', 'f'],
    parents: { b: ['a'], c: ['a'], d: ['b'], e: ['c'], f: ['d', 'e'] },
  };
  const bad = new Set(['b', 'e', 'f']);
  const report = await bisectDag(dag, detectorFrom(bad));
  const exact = await fullDagScan(dag, detectorFrom(bad));
  assert.deepEqual(exact.boundary, ['b', 'e']);
  const check = crossCheck(report, exact);
  assert.equal(check.ok, true, check.summary);
  assert.deepEqual(check.extra, []);
  assert.deepEqual(check.missing, []);
});

test('cross-check exposes a flaky detector contradicting the report', async () => {
  const dag: Dag = {
    nodes: ['a', 'b'],
    parents: { b: ['a'] },
  };
  const report = await bisectDag(dag, detectorFrom(new Set(['b'])));
  assert.deepEqual(report.boundary, ['b']);
  // Full scan sees a different (flaky) world where b is good.
  const exact = await fullDagScan(dag, detectorFrom(new Set()));
  const check = crossCheck(report, exact);
  assert.equal(check.ok, false);
  assert.deepEqual(check.extra, ['b']);
  assert.match(check.summary, /^MISMATCH:/);
});

test('query evidence is sequential and in topological order', async () => {
  const dag: Dag = {
    nodes: ['d', 'b', 'a', 'c'],
    parents: { b: ['a'], c: ['a'], d: ['b', 'c'] },
  };
  const report = await bisectDag(dag, detectorFrom(new Set(['c'])));
  assert.deepEqual(
    report.queries.map((q) => q.seq),
    [1, 2, 3, 4],
  );
  assert.deepEqual(report.queries.map((q) => q.version), ['a', 'b', 'c', 'd']);
  assert.deepEqual(report.boundary, ['c']);
});

test('invalid DAGs are rejected', async () => {
  assert.throws(
    () => topoOrder({ nodes: ['a', 'b'], parents: { a: ['b'], b: ['a'] } }),
    /cycle detected/,
  );
  assert.throws(
    () => topoOrder({ nodes: ['a'], parents: { a: ['ghost'] } }),
    /unknown parent "ghost"/,
  );
  await assert.rejects(
    () => bisectDag({ nodes: ['a', 'a'], parents: {} }, detectorFrom(new Set())),
    /duplicate node names/,
  );
});

test('invalid detector output is treated as pending with evidence', async () => {
  const weird = (() => 'maybe') as unknown as Detector;
  const report = await bisectDag({ nodes: ['a'], parents: {} }, weird);
  assert.deepEqual(report.pending, ['a']);
  assert.deepEqual(report.candidates, ['a']);
  assert.match(report.queries[0]?.error ?? '', /invalid detector result/);
});

test('zero budget probes nothing and keeps every version untested', async () => {
  const dag: Dag = {
    nodes: ['a', 'b'],
    parents: { b: ['a'] },
  };
  const report = await bisectDag(dag, detectorFrom(new Set(['b'])), { budget: 0 });
  assert.equal(report.used, 0);
  assert.deepEqual(report.untested, ['a', 'b']);
  assert.deepEqual(report.candidates, ['a', 'b']);
});
