'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Ledger, Fraction, TraceError } = require('../src/ledger');

const F = (s) => Fraction.parse(s);

// ---------- Fraction basics ----------

test('fraction parse/normalize/arith', () => {
  assert.equal(F('2/4').toString(), '1/2');
  assert.equal(F('0.001').toString(), '1/1000');
  assert.equal(F('1/3').add(F('1/6')).toString(), '1/2');
  assert.equal(F('3/4').mul(F('8/9')).toString(), '2/3');
  assert.throws(() => F('1/0'), (e) => e.code === 'E_RATIONAL');
  assert.throws(() => F('abc'), (e) => e.code === 'E_RATIONAL');
});

test('decimal output carries exact fraction and half-unit error bound', () => {
  const q = F('1/3').toDecimal(4);
  assert.equal(q.exact, '1/3');
  assert.equal(q.decimal, '0.3333');
  assert.equal(q.bound.toString(), '1/20000');
  assert.ok(q.error.cmp(q.bound) <= 0, `error ${q.error} exceeds bound ${q.bound}`);
  const q2 = F('99999/100000').toDecimal(2);
  assert.equal(q2.decimal, '1.00');
  assert.ok(q2.error.cmp(q2.bound) <= 0);
  const q3 = F('1/2').toDecimal(0); // exact half unit: allowed (<= bound)
  assert.equal(q3.decimal, '1');
  assert.ok(q3.error.cmp(q3.bound) <= 0);
});

// ---------- Acceptance 1: n<=8 split/join tree, path enumeration ----------

test('split/join tree (n=8): path enumeration cross-checks cumulative ratios', () => {
  const L = new Ledger();
  L.create('root', 840);
  L.split('root', [
    { id: 'a', ratio: '1/2' },
    { id: 'b', ratio: '1/3' },
    { id: 'c', ratio: '1/6' },
  ]);
  L.split('a', [
    { id: 'a1', ratio: '3/4' },
    { id: 'a2', ratio: '1/4' },
  ]);
  L.join(['b', 'c'], 'bc', '1/4'); // 25% loss
  L.split('bc', [
    { id: 'x', ratio: '2/3' },
    { id: 'y', ratio: '1/3' },
  ]);
  // live leaves: a1, a2, x, y (8 batches total)
  assert.equal(L.inventory().length, 4);

  const rootQty = F('840');
  const paths = L.paths('root');
  // b and c both flow into bc, so maximal paths: a1, a2, b->x, b->y, c->x, c->y
  assert.equal(paths.length, 6);

  // every leaf quantity equals rootQty * (sum of cumulative path ratios to it)
  const byLeaf = new Map();
  for (const p of paths) {
    const leaf = p.path[p.path.length - 1];
    byLeaf.set(leaf, (byLeaf.get(leaf) || Fraction.zero()).add(p.ratio));
  }
  for (const [leaf, ratio] of byLeaf) {
    const expected = rootQty.mul(ratio);
    const actual = L.quantity(leaf).exact;
    assert.equal(actual, expected.toString(), `leaf ${leaf} mismatch`);
  }

  // lossless subtree (root -> a -> a1/a2) conserves quantity exactly
  const aPaths = L.paths('a');
  const aSum = aPaths.reduce((s, p) => s.add(p.ratio), Fraction.zero());
  assert.equal(aSum.toString(), '1');
  const aLeafQty = aPaths
    .map((p) => F(L.quantity(p.path[p.path.length - 1]).exact))
    .reduce((s, q) => s.add(q), Fraction.zero());
  assert.equal(aLeafQty.toString(), L.quantity('a').exact);

  // join loss is reflected: bc = (280 + 140) * 3/4 = 315
  assert.equal(L.quantity('bc').exact, '315');
  // cumulative ratio root->x = 1/3 * 3/4 * 2/3 = 1/6 (via b)
  const bx = L.pathsBetween('b', 'x');
  assert.equal(bx.length, 1);
  assert.equal(bx[0].ratio.toString(), '1/2'); // (3/4)*(2/3)
  assert.deepEqual(bx[0].path, ['b', 'bc', 'x']);

  // ancestors / descendants
  assert.deepEqual(new Set(L.ancestors('x')), new Set(['bc', 'b', 'c', 'root']));
  assert.deepEqual(new Set(L.descendants('root')), new Set(['a', 'b', 'c', 'a1', 'a2', 'bc', 'x', 'y']));
});

// ---------- Acceptance 2: ratio sum off by 1/1000000 rolls back ----------

test('ratio sum short by 1/1000000 -> E_RATIONAL, transaction rolls back, inventory unchanged', () => {
  const L = new Ledger();
  L.create('root', 1000000);
  const before = L.inventory().map((b) => `${b.id}:${b.quantity}`);

  assert.throws(
    () => L.split('root', [
      { id: 'p', ratio: '499999/1000000' },
      { id: 'q', ratio: '499999/1000000' }, // sum = 999998/1000000
    ]),
    (e) => e.code === 'E_RATIONAL'
  );
  assert.deepEqual(L.inventory().map((b) => `${b.id}:${b.quantity}`), before);
  assert.equal(L.undoDepth, 1); // failed tx left no trace in history

  // multi-op transaction: first op valid, second invalid -> whole tx rolled back
  assert.throws(
    () => L.transact((tx) => {
      tx.split('root', [{ id: 'p', ratio: '1/2' }, { id: 'q', ratio: '1/2' }]);
      tx.split('p', [{ id: 'p1', ratio: '999999/1000000' }]); // sum != 1
    }),
    (e) => e.code === 'E_RATIONAL'
  );
  assert.deepEqual(L.inventory().map((b) => `${b.id}:${b.quantity}`), before);
  assert.throws(() => L.quantity('p'), (e) => e.code === 'E_NOTFOUND');
  assert.equal(L.undoDepth, 1);
});

// ---------- Acceptance 3: zero-loss boundary, tangent ratios ----------

test('boundary: zero loss join and tangent (exactly partitioning) ratios', () => {
  const L = new Ledger();
  L.create('r1', '100');
  L.create('r2', '50');
  L.join(['r1', 'r2'], 'j', '0'); // zero loss boundary
  assert.equal(L.quantity('j').exact, '150');

  L.split('j', [{ id: 'only', ratio: '1' }]); // tangent: single child ratio exactly 1
  assert.equal(L.quantity('only').exact, '150');

  L.split('only', [
    { id: 't1', ratio: '1/3' },
    { id: 't2', ratio: '1/3' },
    { id: 't3', ratio: '1/3' },
  ]); // tangent equal thirds sum exactly to 1
  assert.equal(L.quantity('t1').exact, '50');
  const total = L.paths('j').reduce((s, p) => s.add(p.ratio), Fraction.zero());
  assert.equal(total.toString(), '1');

  // loss = 1 boundary: output is exactly zero
  L.create('z', '7');
  L.join(['z'], 'zz', '1');
  assert.equal(L.quantity('zz').exact, '0');

  // out-of-range loss rejected
  L.create('bad', '1');
  assert.throws(() => L.join(['bad'], 'badout', '3/2'), (e) => e.code === 'E_RATIONAL');
  assert.throws(() => L.join(['bad'], 'badout', '-1/10'), (e) => e.code === 'E_RATIONAL');
  // non-positive / >1 split ratios rejected
  assert.throws(() => L.split('bad', [{ id: 'b1', ratio: '0' }, { id: 'b2', ratio: '1' }]), (e) => e.code === 'E_RATIONAL');
});

// ---------- Acceptance 4: undo join removes pollution certificate ----------

test('undo join makes pollution certificate disappear; redo restores it', () => {
  const L = new Ledger();
  L.create('bad', 10);
  L.create('good', 20);
  L.quarantine('bad');
  L.join(['bad', 'good'], 'final', '0');

  let r = L.pollutes('bad', 'final');
  assert.equal(r.polluted, true);
  assert.deepEqual(r.certificate.path, ['bad', 'final']);
  assert.equal(r.certificate.ratio.toString(), '1');

  assert.equal(L.undo(), true); // undo the join
  r = L.pollutes('bad', 'final');
  assert.equal(r.polluted, false);
  assert.equal(r.certificate, null);
  assert.equal(r.reason, 'unknown batch');
  assert.ok(!L.descendants('bad').includes('final'));

  assert.equal(L.redo(), true); // redo restores certificate
  r = L.pollutes('bad', 'final');
  assert.equal(r.polluted, true);
  assert.deepEqual(r.certificate.path, ['bad', 'final']);

  // quarantine itself is undoable
  L.undo(); // undo join
  L.undo(); // undo quarantine
  r = L.pollutes('bad', 'final');
  assert.equal(r.polluted, false);
  assert.equal(r.reason, 'unknown batch'); // join output no longer exists

  // non-quarantined batch never pollutes
  const L2 = new Ledger();
  L2.create('x', 1);
  L2.join(['x'], 'y', '0');
  const r2 = L2.pollutes('x', 'y');
  assert.equal(r2.polluted, false);
  assert.equal(r2.reason, 'batch "x" is not quarantined');
});

// ---------- Errors: E_RATIONAL / E_CYCLE ----------

test('invalid ratios -> E_RATIONAL; cyclic genealogy -> E_CYCLE', () => {
  const L = new Ledger();
  L.create('a', 10);
  L.split('a', [{ id: 'b', ratio: '1/2' }, { id: 'c', ratio: '1/2' }]);

  // E_RATIONAL
  assert.throws(() => L.split('b', [{ id: 'd', ratio: 'x/y' }]), (e) => e.code === 'E_RATIONAL');
  assert.throws(() => L.split('b', [{ id: 'd', ratio: '-1/2' }, { id: 'e', ratio: '3/2' }]), (e) => e.code === 'E_RATIONAL');
  assert.throws(() => L.create('n', '-5'), (e) => e.code === 'E_RATIONAL');

  // E_CYCLE: reuse an ancestor id as split output
  assert.throws(
    () => L.split('b', [{ id: 'a', ratio: '1/2' }, { id: 'd', ratio: '1/2' }]),
    (e) => e.code === 'E_CYCLE'
  );
  // E_CYCLE: self-loop via join output
  assert.throws(() => L.join(['c'], 'c', '0'), (e) => e.code === 'E_CYCLE');
  // E_CYCLE: join output reuses an ancestor of an input
  L.create('m', 1);
  L.join(['m'], 'm1', '0');
  assert.throws(() => L.join(['m1'], 'm', '0'), (e) => e.code === 'E_CYCLE');

  // nothing was committed by the failing ops
  assert.equal(L.undoDepth, 4);
});

// ---------- undo/redo of quantity & inventory ----------

test('undo/redo restores inventory exactly', () => {
  const L = new Ledger();
  L.create('r', 100);
  L.split('r', [{ id: 's1', ratio: '2/5' }, { id: 's2', ratio: '3/5' }]);
  const snap = L.inventory().map((b) => `${b.id}:${b.quantity}`).sort();
  L.join(['s1', 's2'], 'j', '1/5');
  assert.equal(L.quantity('j').exact, '80');
  L.undo();
  assert.deepEqual(L.inventory().map((b) => `${b.id}:${b.quantity}`).sort(), snap);
  L.redo();
  assert.equal(L.quantity('j').exact, '80');
  // new transaction clears redo tail
  L.undo();
  L.quarantine('s1');
  assert.equal(L.redoDepth, 0);
  assert.equal(L.redo(), false);
});
