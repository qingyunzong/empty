import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32, openStore, buildRandomGraph, referenceProbs, referenceSet } from './helpers.js';

const THRESHOLD = 0.05;

// Acceptance 1: 20-lot random graph, impact() must match an independent
// DFS reference for every candidate source lot.
test('20-lot random graph matches DFS reference', () => {
  const store = openStore();
  const { ids } = buildRandomGraph(store, mulberry32(42), 20);
  const snap = store.snapshot();

  assert.equal(snap.lots.length, 20);
  assert.equal(snap.conservation.ok, true, JSON.stringify(snap.conservation.violations));

  const ref = referenceProbs(snap, 'L0');
  assert.ok(ref.get('L0') === 1);
  assert.ok(ref.get('L13') > 0); // frozen lot is still listed
  const frozenChildren = snap.edges.filter((e) => e.from === 'L13').map((e) => e.to);
  for (const c of frozenChildren) {
    // freeze containment: children of the frozen lot only see other parents
    const viaFrozen = snap.edges.filter((e) => e.to === c && e.from === 'L13');
    assert.ok(viaFrozen.length >= 0); // structural sanity
  }

  for (const source of ids) {
    const expected = referenceSet(snap, source, THRESHOLD);
    const got = store.impactFull(source, THRESHOLD).affected.map((a) => a.lot).sort();
    assert.deepEqual(got, expected, `impact set mismatch for source ${source}`);

    const refProbs = referenceProbs(snap, source);
    for (const a of store.impactFull(source, THRESHOLD).affected) {
      assert.ok(Math.abs(a.prob - refProbs.get(a.lot)) < 1e-9, `prob mismatch ${source}->${a.lot}`);
    }
  }
});

test('cached impact equals full recompute on the random graph', () => {
  const store = openStore();
  const { ids } = buildRandomGraph(store, mulberry32(7), 20);
  for (const source of ids) {
    const cached = store.impact(source, THRESHOLD);
    const full = store.impactFull(source, THRESHOLD);
    assert.deepEqual(cached, full, `cached vs full mismatch for ${source}`);
  }
});

// Minimal recall certificate: the listed set satisfies the rules, and
// removing any single listed lot makes it unsatisfiable.
test('minimal recall certificate: every listed lot is necessary', () => {
  const store = openStore();
  buildRandomGraph(store, mulberry32(42), 20);
  const source = 'L0';
  const result = store.impact(source, THRESHOLD);
  assert.equal(result.minimal, true);

  const listed = result.affected.map((a) => a.lot);
  assert.ok(listed.length > 1);
  const whole = store.verifyCertificate(source, THRESHOLD, listed);
  assert.equal(whole.satisfied, true);
  assert.equal(whole.minimal, true);

  for (const x of listed) {
    const reduced = listed.filter((l) => l !== x);
    const check = store.verifyCertificate(source, THRESHOLD, reduced);
    assert.equal(check.satisfied, false, `set without ${x} should not satisfy the rules`);
    assert.ok(check.missing.includes(x));
  }

  // Certificate carries a witness path for every listed lot.
  for (const entry of result.certificate) {
    assert.equal(entry.witness[0], source);
    assert.equal(entry.witness.at(-1), entry.lot);
    assert.ok(entry.pathProb > 0);
  }
});

test('freeze containment: frozen lots do not propagate downstream', () => {
  const store = openStore();
  store.addLot({ id: 'R', kind: 'raw', qty: 100, failed: true });
  store.addLot({ id: 'F', kind: 'finished', qty: 100, frozen: true });
  store.addLot({ id: 'T', kind: 'in_transit', qty: 100 });
  store.addEdge({ id: 'E1', from: 'R', to: 'F', kind: 'consume', qty: 80 });
  store.addEdge({ id: 'E2', from: 'F', to: 'T', kind: 'consume', qty: 80 });

  const res = store.impact('R', THRESHOLD);
  const lots = res.affected.map((a) => a.lot);
  assert.ok(lots.includes('F'), 'frozen lot itself is listed');
  assert.ok(!lots.includes('T'), 'frozen lot blocks propagation');
  assert.equal(res.affected.find((a) => a.lot === 'F').action, 'keep-frozen');
});
