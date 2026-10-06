import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cluster } from '../src/cluster.js';
import { VersionVector } from '../src/version-vector.js';

test('read requires at least two reachable replicas', () => {
  const c = new Cluster<string>(['A', 'B', 'C']);
  c.partition([['A'], ['B', 'C']]);
  assert.throws(() => c.read('A', 'k'), /needs >= 2 replicas/);
  c.heal();
  c.write('A', 'k', 'v');
  const out = c.read('B', 'k');
  assert.ok(out.contacted.length >= 2);
});

test('read merges conflict sets and read-repairs replicas missing versions', () => {
  const c = new Cluster<string>(['A', 'B', 'C']);
  c.partition([['A', 'B'], ['C']]);
  const w1 = c.write('A', 'k', 'fromA');
  c.syncRound(); // anti-entropy inside {A,B}: B now holds w1; C is isolated
  const out = c.read('B', 'k'); // contacts B only? no: partition still {A,B}|{C}
  assert.deepEqual([...out.contacted].sort(), ['A', 'B']);
  assert.deepEqual(out.siblings.map((s) => s.value), ['fromA']);

  // Cut A off; C coordinates a read and learns w1 from B via read repair.
  c.partition([['A'], ['B', 'C']]);
  const out2 = c.read('C', 'k');
  assert.deepEqual(out2.siblings.map((s) => s.value), ['fromA']);
  const repairC = out2.repairs.find((r) => r.replica === 'C');
  assert.ok(repairC, 'expected read repair on C');
  assert.deepEqual(repairC.installed, [w1.vv.toString()]);
  assert.deepEqual(
    c.replicas.find((r) => r.id === 'C')!.readLocal('k').map((s) => s.value),
    ['fromA'],
  );
});

test('concurrent writes survive as siblings; no clock-based overwrite', () => {
  const c = new Cluster<string>(['A', 'B']);
  const w1 = c.write('A', 'k', 'A-value');
  const w2 = c.write('B', 'k', 'B-value');
  c.syncToFixpoint();
  for (const r of c.replicas) {
    assert.deepEqual(
      r.readLocal('k').map((s) => s.value).sort(),
      ['A-value', 'B-value'],
    );
  }
  assert.ok(w1.vv.compare(w2.vv) === 'concurrent');
});

test('superseded version is retracted cluster-wide and never returns', () => {
  const c = new Cluster<string>(['A', 'B', 'C']);
  const w1 = c.write('A', 'k', 'old');
  c.syncToFixpoint();
  const w2 = c.write('B', 'k', 'new', w1.vv);
  c.syncToFixpoint();
  for (const r of c.replicas) {
    const siblings = r.readLocal('k');
    assert.equal(siblings.length, 1);
    assert.equal(siblings[0]!.value, 'new');
  }
  // Stale re-delivery of w1 (e.g. a delayed message) must not resurrect it.
  c.replicas[2]!.accept('k', [{ value: 'old', vv: w1.vv }]);
  const siblings = c.replicas[2]!.readLocal('k');
  assert.equal(siblings.length, 1);
  assert.equal(siblings[0]!.value, 'new');
});

test('read outcome exposes dominance evidence for the merge it performed', () => {
  const c = new Cluster<string>(['A', 'B']);
  const w1 = c.write('A', 'k', 'v1');
  c.syncToFixpoint();
  // B writes with stale (empty) context: concurrent with w1.
  c.write('B', 'k', 'v2-concurrent', VersionVector.zero());
  const out = c.read('A', 'k');
  assert.equal(out.siblings.length, 2);
  assert.ok(
    out.evidence.some((e) => e.relation === 'concurrent'),
    'expected concurrency evidence',
  );
  // Now a superseding write with full context retracts both.
  c.write('A', 'k', 'v3', out.context);
  const out2 = c.read('B', 'k');
  assert.equal(out2.siblings.length, 1);
  const retractions = out2.evidence.filter((e) => e.relation === 'dominates');
  assert.equal(retractions.length, 2);
  assert.ok(retractions.every((e) => e.retracted !== undefined));
});
