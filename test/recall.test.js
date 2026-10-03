'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { IntervalSet } = require('../src/intervals');
const { RecallStore } = require('../src/store');
const { run: cliRun } = require('../src/cli');

const RESULTS_FILE = path.join(__dirname, '..', 'test-results.txt');
fs.writeFileSync(
  RESULTS_FILE,
  `recall-trace test results\nnode: ${process.version}\ndate: ${new Date().toISOString()}\n\n`
);
function report(title, data) {
  const body = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  fs.appendFileSync(RESULTS_FILE, `=== ${title} ===\n${body}\n\n`);
}

// Independent reference algorithm: enumerate every genealogy path from the
// component downstream by plain DFS over raw records. Used to cross-check
// the library's query results.
function referenceEnumerate(records, component) {
  const byInput = new Map();
  for (const rec of records) {
    for (const input of rec.inputs) {
      if (!byInput.has(input)) byInput.set(input, []);
      byInput.get(input).push(rec);
    }
  }
  const paths = new Map();
  const dfs = (batch, path, used) => {
    const outs = (byInput.get(batch) || []).filter((r) => !used.has(r.id));
    if (outs.length === 0) {
      if (!paths.has(batch)) paths.set(batch, []);
      paths.get(batch).push(path);
      return;
    }
    for (const rec of outs) {
      used.add(rec.id);
      dfs(rec.output, [...path, rec.id], used);
      used.delete(rec.id);
    }
  };
  dfs(component, [], new Set());
  return paths;
}

test('interval set: union / intersect / subtract, half-open semantics', () => {
  const a = new IntervalSet([{ start: 0, end: 5 }, { start: 10, end: 20 }]);
  const b = new IntervalSet([{ start: 3, end: 12 }]);
  assert.deepEqual(a.union(b).toJSON(), [{ start: 0, end: 20 }]);
  assert.deepEqual(a.intersect(b).toJSON(), [{ start: 3, end: 5 }, { start: 10, end: 12 }]);
  assert.deepEqual(a.subtract(b).toJSON(), [{ start: 0, end: 3 }, { start: 12, end: 20 }]);

  // endpoint touching is not an overlap
  assert.equal(IntervalSet.of(0, 5).overlapsPositive(IntervalSet.of(5, 10)), false);
  assert.equal(IntervalSet.of(0, 5).intersect(IntervalSet.of(5, 10)).isEmpty(), true);
  // crossing by one millisecond is an overlap
  assert.equal(IntervalSet.of(0, 6).overlapsPositive(IntervalSet.of(5, 10)), true);
  assert.deepEqual(IntervalSet.of(0, 6).intersect(IntervalSet.of(5, 10)).toJSON(), [{ start: 5, end: 6 }]);

  assert.throws(() => new IntervalSet([{ start: 9, end: 2 }]), /reversed/);

  const out = {
    union: a.union(b).toJSON(),
    intersect: a.intersect(b).toJSON(),
    subtract: a.subtract(b).toJSON(),
    touchOverlap: false,
    crossOneMs: IntervalSet.of(0, 6).intersect(IntervalSet.of(5, 10)).toJSON(),
  };
  report('interval set operations', out);
});

function buildConvergingStore() {
  const store = new RecallStore([{ local: 0, utc: 1000 }]);
  const batch = (id, s, e, shelf, pack) =>
    store.addBatch({ id, localStart: s, localEnd: e, shelfLife: shelf, packaging: pack });
  batch('A', 0, 10, 100, 10);
  batch('B', 0, 10, 100, 10);
  batch('C', 0, 10, 100, 10);
  batch('D', 0, 10, 100, 10);
  batch('E', 0, 10, 100, 10);
  batch('I1', 10, 20, 1000, 50);
  batch('I2', 20, 30, 1000, 50);
  batch('P1', 30, 40, 50, 10); // shelf window UTC [1040, 1090)
  batch('P2', 30, 40, 5000, 2000); // shelf window UTC [1040, 6040), pack [1040, 3040)
  store.addRecord({ id: 'r1', inputs: ['A', 'B'], output: 'I1' });
  store.addRecord({ id: 'r2', inputs: ['I1', 'C'], output: 'I2' });
  store.addRecord({ id: 'r3', inputs: ['I2', 'D'], output: 'P1' });
  store.addRecord({ id: 'r4', inputs: ['I2', 'E'], output: 'P2' });
  store.snapshot('s1');
  return store;
}

test('acceptance 1: three-layer converging genealogy, partial shelf-life hits', () => {
  const store = buildConvergingStore();
  const res = store.query({ snapshot: 's1', component: 'A', observeStart: 2000, observeEnd: 3000 });
  const byProduct = new Map(res.affected.map((r) => [r.product, r]));

  assert.deepEqual([...byProduct.keys()].sort(), ['P1', 'P2']);
  assert.equal(byProduct.get('P1').withinShelfLife, false);
  assert.deepEqual(byProduct.get('P1').hitIntervalUtc, []);
  assert.equal(byProduct.get('P2').withinShelfLife, true);
  assert.deepEqual(byProduct.get('P2').hitIntervalUtc, [{ start: 2000, end: 3000 }]);
  assert.equal(byProduct.get('P2').inPackagingSeal, true);
  assert.deepEqual(byProduct.get('P2').packagingHitIntervalUtc, [{ start: 2000, end: 3000 }]);
  assert.equal(byProduct.get('P1').inPackagingSeal, false);

  // path certificates: A -> I1 -> I2 -> P*
  const p2cert = byProduct.get('P2').certificates[0];
  assert.deepEqual(p2cert.path.map((p) => p.recordId), ['r1', 'r2', 'r4']);
  assert.equal(p2cert.snapshot, 's1');
  assert.match(p2cert.digest, /^[0-9a-f]{24}$/);

  report('acceptance 1: converging genealogy query (observe UTC 2000-3000)', res);
});

test('acceptance 2: endpoint touch excluded, one-millisecond crossing included', () => {
  const store = new RecallStore([{ local: 0, utc: 1000 }]);
  store.addBatch({ id: 'A', localStart: 0, localEnd: 10, shelfLife: 100, packaging: 10 });
  store.addBatch({ id: 'F', localStart: 0, localEnd: 10, shelfLife: 100, packaging: 10 });
  store.addRecord({ id: 'r1', inputs: ['A'], output: 'F' });
  store.snapshot('snap');
  // F shelf window UTC: [1010, 1110)

  const touch = store.query({ snapshot: 'snap', component: 'A', observeStart: 900, observeEnd: 1010 });
  assert.equal(touch.affected[0].withinShelfLife, false);
  assert.deepEqual(touch.affected[0].hitIntervalUtc, []);

  const cross = store.query({ snapshot: 'snap', component: 'A', observeStart: 900, observeEnd: 1011 });
  assert.equal(cross.affected[0].withinShelfLife, true);
  assert.deepEqual(cross.affected[0].hitIntervalUtc, [{ start: 1010, end: 1011 }]);

  report('acceptance 2: endpoint touch vs 1ms crossing', {
    shelfWindowUtc: [1010, 1110],
    touchObserve: [900, 1010],
    touchHit: touch.affected[0].hitIntervalUtc,
    crossObserve: [900, 1011],
    crossHit: cross.affected[0].hitIntervalUtc,
  });
});

test('acceptance 3: snapshot rollback, old and new results coexist, reference check', () => {
  const store = new RecallStore([{ local: 0, utc: 0 }]);
  const batch = (id) => store.addBatch({ id, localStart: 0, localEnd: 10, shelfLife: 1000, packaging: 100 });
  for (const id of ['A', 'A2', 'M1', 'M2', 'P']) batch(id);
  store.addRecord({ id: 'r1', inputs: ['A'], output: 'M1' });
  store.addRecord({ id: 'r2', inputs: ['A'], output: 'M2' });
  store.addRecord({ id: 'r3', inputs: ['M1', 'M2'], output: 'P' });
  store.snapshot('s1');

  // correction: M2 no longer consumes A
  store.correctRecord({ id: 'r2', inputs: ['A2'], output: 'M2' });
  store.snapshot('s2');

  // rollback live state to s1; snapshots s1 and s2 must both stay queryable
  store.rollback('s1');
  // further corrections after rollback must not rewrite history
  store.correctRecord({ id: 'r1', inputs: ['A2'], output: 'M1' });
  store.snapshot('s3');

  const q1 = store.query({ snapshot: 's1', component: 'A', observeStart: 0, observeEnd: 2000 });
  const q2 = store.query({ snapshot: 's2', component: 'A', observeStart: 0, observeEnd: 2000 });

  // reference algorithm over each snapshot's raw records
  const snapRecords = (snap) => [...store.snapshots.get(snap).records.values()].map((v) => v.record);
  const ref1 = referenceEnumerate(snapRecords('s1'), 'A');
  const ref2 = referenceEnumerate(snapRecords('s2'), 'A');

  const products1 = q1.affected.map((r) => r.product).sort();
  const products2 = q2.affected.map((r) => r.product).sort();
  assert.deepEqual(products1, [...ref1.keys()].sort());
  assert.deepEqual(products2, [...ref2.keys()].sort());
  assert.deepEqual(products1, ['P']); // only P is a finished product (M1/M2 are consumed)
  assert.deepEqual(products2, ['P']);

  // s1: two paths A->M1->P and A->M2->P; s2: only A->M1->P
  const certPaths = (q) =>
    q.affected[0].certificates.map((c) => c.path.map((p) => p.recordId).join('>')).sort();
  assert.deepEqual(certPaths(q1), ['r1>r3', 'r2>r3']);
  assert.deepEqual(certPaths(q2), ['r1>r3']);
  assert.equal(ref1.get('P').length, 2);
  assert.equal(ref2.get('P').length, 1);

  // certificates carry the record versions captured by their snapshot
  const versions1 = q1.affected[0].certificates.flatMap((c) => c.path.map((p) => p.version));
  assert.deepEqual(versions1, [1, 1, 1, 1]); // two paths x two records, all v1 in s1
  const versions2 = q2.affected[0].certificates.flatMap((c) => c.path.map((p) => p.version));
  assert.deepEqual(versions2, [1, 1]); // r1 v1, r3 v1; corrected r2 (v2) not on this path
  assert.equal(store.snapshots.get('s2').records.get('r2').version, 2);
  assert.equal(store.snapshots.get('s1').records.get('r2').version, 1);

  // old snapshot results are stable even after post-rollback corrections
  const q1again = store.query({ snapshot: 's1', component: 'A', observeStart: 0, observeEnd: 2000 });
  assert.deepEqual(q1again, q1);

  report('acceptance 3: rollback coexistence + reference algorithm', {
    s1: { products: products1, paths: certPaths(q1) },
    s2: { products: products2, paths: certPaths(q2) },
    reference: {
      s1: [...ref1.entries()].map(([k, v]) => [k, v.map((p) => p.join('>'))]),
      s2: [...ref2.entries()].map(([k, v]) => [k, v.map((p) => p.join('>'))]),
    },
    s1StableAfterRollback: JSON.stringify(q1again) === JSON.stringify(q1),
  });
});

test('errors: unknown snapshot, reversed interval, negative shelf life', () => {
  const store = buildConvergingStore();
  assert.throws(
    () => store.query({ snapshot: 'ghost', component: 'A', observeStart: 0, observeEnd: 1 }),
    (e) => e.code === 'ERR_UNKNOWN_SNAPSHOT'
  );
  assert.throws(
    () => store.query({ snapshot: 's1', component: 'A', observeStart: 100, observeEnd: 50 }),
    (e) => e.code === 'ERR_INTERVAL_REVERSED'
  );
  assert.throws(
    () => store.addBatch({ id: 'X', localStart: 0, localEnd: 1, shelfLife: -5, packaging: 0 }),
    (e) => e.code === 'ERR_NEGATIVE_SHELF_LIFE'
  );
  assert.throws(() => store.rollback('ghost'), (e) => e.code === 'ERR_UNKNOWN_SNAPSHOT');
  assert.throws(
    () => store.correctRecord({ id: 'nope', inputs: ['A'], output: 'B' }),
    (e) => e.code === 'ERR_UNKNOWN_RECORD'
  );
  report('error cases', {
    unknownSnapshot: 'ERR_UNKNOWN_SNAPSHOT',
    reversedInterval: 'ERR_INTERVAL_REVERSED',
    negativeShelfLife: 'ERR_NEGATIVE_SHELF_LIFE',
    unknownRollbackSnapshot: 'ERR_UNKNOWN_SNAPSHOT',
    correctUnknownRecord: 'ERR_UNKNOWN_RECORD',
  });
});

test('cli: JSON in, JSON out', () => {
  const demoPath = path.join(__dirname, '..', 'examples', 'recall-demo.json');
  const input = JSON.parse(fs.readFileSync(demoPath, 'utf8'));
  const out = cliRun(input);
  const q1 = out.results.find((r) => r.type === 'query' && r.id === 'q1');
  const q2 = out.results.find((r) => r.type === 'query' && r.id === 'q2');
  const q3 = out.results.find((r) => r.type === 'query' && r.id === 'q3');
  const q4 = out.results.find((r) => r.type === 'query' && r.id === 'q4');

  const q1ByProduct = new Map(q1.affected.map((r) => [r.product, r]));
  assert.equal(q1ByProduct.get('P1').withinShelfLife, false);
  assert.equal(q1ByProduct.get('P2').withinShelfLife, true);
  assert.equal(q1ByProduct.get('P2').inPackagingSeal, true);
  assert.equal(q2.affected.find((r) => r.product === 'P1').withinShelfLife, true);
  assert.equal(q3.error.code, 'ERR_UNKNOWN_SNAPSHOT');
  assert.equal(q4.error.code, 'ERR_INTERVAL_REVERSED');

  report('cli end-to-end (examples/recall-demo.json)', out);
});
