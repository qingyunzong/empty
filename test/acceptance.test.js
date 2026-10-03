import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/ledger.js';
import { Rational } from '../src/rational.js';

// Independent path enumerator used to cross-check the ledger (acceptance 1).
function enumeratePaths(edges, from, to) {
  const adj = new Map();
  for (const e of edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from).push(e);
  }
  const res = [];
  const dfs = (node, path, ratio, seen) => {
    if (node === to) { res.push({ path: [...path], ratio }); return; }
    for (const e of adj.get(node) || []) {
      if (seen.has(e.to)) continue;
      seen.add(e.to); path.push(e.to);
      dfs(e.to, path, ratio.mul(e.ratio), seen);
      path.pop(); seen.delete(e.to);
    }
  };
  dfs(from, [from], Rational.ONE, new Set([from]));
  return res;
}

test('acceptance 1: n<=8 split/merge tree verified by path enumeration', () => {
  const l = new Ledger();
  // 8 batches: R -> A,B,C ; A -> A1,A2 ; A1+B -> J1 ; A2+C -> J2
  l.create('R', '8');
  l.split('R', ['1/2', '1/3', '1/6'], ['A', 'B', 'C']);
  l.split('A', ['1/4', '3/4'], ['A1', 'A2']);
  l.join(['A1', 'B'], 'J1', '1/5');
  l.join(['A2', 'C'], 'J2', '0');
  assert.equal(l.batches.size, 8);

  const edges = l.edges.map((e) => ({ from: e.from, to: e.to, ratio: e.ratio }));
  const indeg = new Map([...l.batches.keys()].map((id) => [id, 0]));
  for (const e of edges) indeg.set(e.to, indeg.get(e.to) + 1);
  const sources = [...indeg.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  assert.deepEqual(sources, ['R']);

  for (const id of l.batches.keys()) {
    // Expected quantity: sum over sources of qty(source) * sum of path ratios.
    let expected = Rational.ZERO;
    for (const s of sources) {
      for (const p of enumeratePaths(edges, s, id)) {
        expected = expected.add(l.getBatch(s).quantity.mul(p.ratio));
      }
    }
    const actual = l.getBatch(id).quantity;
    assert.equal(actual.toString(), expected.toString(), `quantity mismatch at ${id}`);

    // Ledger's own path enumeration must agree with the independent one.
    const pr = l.pathRatios('R', id);
    const indie = enumeratePaths(edges, 'R', id);
    assert.equal(pr.paths.length, indie.length);
    const indieTotal = indie.reduce((a, p) => a.add(p.ratio), Rational.ZERO);
    assert.equal(pr.total.toString(), indieTotal.toString());
  }

  // Spot-check cumulative ratios along concrete paths.
  const rj1 = l.pathRatios('R', 'J1');
  // R->A(1/2)->A1(1/4)->J1(4/5) = 1/10 ; R->B(1/3)->J1(4/5) = 4/15 ; total = 11/30
  assert.equal(rj1.total.toString(), '11/30');
  assert.equal(l.getBatch('J1').quantity.toString(), '44/15'); // 8 * 11/30
});

test('acceptance 2: ratio sum off by 1/1000000 rolls back, inventory unchanged', () => {
  const l = new Ledger();
  l.create('R', '1000000');
  const before = JSON.stringify(l.toJSON());

  const tx = l.begin();
  tx.create('TMP', '5'); // a step that succeeds inside the same transaction
  assert.throws(
    () => tx.split('R', ['1/2', '499999/1000000'], ['A', 'B']),
    (e) => e.code === 'E_RATIONAL',
  );

  assert.equal(JSON.stringify(l.toJSON()), before);
  assert.deepEqual(l.inventory(), [{ id: 'R', quantity: '1000000', quarantined: false }]);
  assert.equal(l.edges.length, 0);
  assert.equal(l.undoStack.length, 1); // only the committed create('R')
});

test('acceptance 3: boundary zero loss and tangent ratios hold', () => {
  const l = new Ledger();
  l.create('X', '3');
  l.create('Y', '4');
  l.join(['X', 'Y'], 'Z', '0'); // zero loss boundary
  assert.equal(l.getBatch('Z').quantity.toString(), '7');

  l.create('S', '6');
  l.split('S', ['1/2', '1/3', '1/6'], ['S1', 'S2', 'S3']); // tangent: sums exactly to 1
  assert.equal(l.getBatch('S1').quantity.toString(), '3');
  assert.equal(l.getBatch('S2').quantity.toString(), '2');
  assert.equal(l.getBatch('S3').quantity.toString(), '1');

  l.create('T', '1000000');
  l.split('T', ['999999/1000000', '1/1000000'], ['T1', 'T2']); // tangent at 1e-6 resolution
  assert.equal(l.getBatch('T1').quantity.toString(), '999999');
  assert.equal(l.getBatch('T2').quantity.toString(), '1');
});

test('acceptance 4: undoing a join removes the contamination certificate', () => {
  const l = new Ledger();
  l.create('A', '2');
  l.create('B', '3');
  l.quarantine('A');
  l.join(['A', 'B'], 'C', '0');

  assert.equal(l.contaminates('A', 'C'), true);
  const cert = l.contamination('C');
  assert.equal(cert.length, 1);
  assert.equal(cert[0].quarantined, 'A');
  assert.equal(cert[0].total.toString(), '1');
  assert.deepEqual(cert[0].paths.map((p) => p.path), [['A', 'C']]);

  assert.equal(l.undo(), true); // undo the join
  assert.equal(l.batches.has('C'), false);
  assert.throws(() => l.contamination('C'), (e) => e.code === 'E_NOT_FOUND');
  assert.throws(() => l.contaminates('A', 'C'), (e) => e.code === 'E_NOT_FOUND');

  assert.equal(l.redo(), true); // redo the join: certificate returns
  assert.equal(l.contaminates('A', 'C'), true);
  assert.equal(l.contamination('C').length, 1);
});
