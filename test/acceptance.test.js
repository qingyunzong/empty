import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/ledger.js';
import { rat, add, sub, abs, cmp, toString } from '../src/rational.js';

const TWO_SEG = [
  { from: 0, to: 2, coefs: [[1, 1], [2, 1]] },      // p(t) = 1 + 2t
  { from: 2, to: 4, coefs: [[0, 1], [0, 1], [1, 1]] }, // p(t) = t^2
];

function makeLedger(segments = TWO_SEG) {
  const l = new Ledger();
  l.loadCurve({ segments });
  return l;
}

// Acceptance 1: two-segment polynomial vs hand-computed integrals.
test('two-segment polynomial matches hand-computed integrals', () => {
  const l = makeLedger();
  l.post({ day: 0, amountNum: 1, amountDen: 1 });
  const cert = l.certify({ from: 0, to: 4 });
  // Hand: day0 = [t+t^2]_0^1 = 2, day1 = [t+t^2]_1^2 = 4,
  //       day2 = [t^3/3]_2^3 = 19/3, day3 = [t^3/3]_3^4 = 37/3.
  const expected = ['2', '4', '19/3', '37/3'];
  assert.deepEqual(cert.days.map((d) => toString(rat(BigInt(d.exact.n), BigInt(d.exact.d)))), expected);
  // Interval sums: [0,2) = 6, [2,4) = 56/3.
  assert.equal(toString(rat(BigInt(cert.intervals[0].exact.n), BigInt(cert.intervals[0].exact.d))), '6');
  assert.equal(toString(rat(BigInt(cert.intervals[1].exact.n), BigInt(cert.intervals[1].exact.d))), '56/3');
  assert.deepEqual(cert.intervals.map((i) => [i.from, i.to]), [[0, 2], [2, 4]]);
  assert.ok(l.verify(cert).ok);
});

// Acceptance 2: after backdate the old certificate fails, the new one verifies.
test('backdate invalidates old certificate, new certificate verifies', () => {
  const l = makeLedger();
  l.post({ day: 1, amountNum: 100, amountDen: 1 });
  const oldCert = l.certify({ from: 0, to: 4 });
  assert.ok(l.verify(oldCert).ok);
  const oldRoot = l.stateRoot();

  l.backdate({ day: 1, newAmount: 200 });
  assert.notEqual(l.stateRoot(), oldRoot);
  assert.throws(() => l.verify(oldCert), (e) => e.code === 'E_CERT');

  const newCert = l.certify({ from: 0, to: 4 });
  assert.ok(l.verify(newCert).ok);
  // Day 3 accrual doubled: 200 * 37/3 = 7400/3.
  assert.equal(toString(rat(BigInt(newCert.days[3].exact.n), BigInt(newCert.days[3].exact.d))), '7400/3');
});

// Acceptance 3: undoPost restores the committed root hash.
test('undoPost restores the committed root hash', () => {
  const l = makeLedger();
  const rootBefore = l.stateRoot();
  const { id } = l.post({ day: 0, amountNum: 42, amountDen: 1 });
  assert.notEqual(l.stateRoot(), rootBefore);
  l.undoPost({ id });
  assert.equal(l.stateRoot(), rootBefore);
});

// Acceptance 4: N <= 7 brute-force daily sum comparison.
test('N<=7 brute-force daily quadrature matches exact accrual', () => {
  const N = 7;
  // p(t) = 1/2 + t/3 + t^2/7 on [0, 7); principal 3/2 posted at day 0.
  const l = makeLedger([{ from: 0, to: N, coefs: [[1, 2], [1, 3], [1, 7]] }]);
  l.post({ day: 0, amountNum: 3, amountDen: 2 });
  const p = (t) => 0.5 + t / 3 + (t * t) / 7;
  const STEPS = 20000;
  let bruteTotal = 0;
  for (let d = 0; d < N; d++) {
    let s = 0;
    for (let i = 0; i < STEPS; i++) s += p(d + (i + 0.5) / STEPS);
    bruteTotal += (s / STEPS) * 1.5;
    const exact = l.accrualForDay(d);
    const exactNum = Number(exact.n) / Number(exact.d);
    assert.ok(Math.abs(exactNum - (s / STEPS) * 1.5) < 1e-6, `day ${d}: ${exactNum} vs quadrature`);
  }
  const cert = l.certify({ from: 0, to: N });
  const total = cert.days.reduce((a, e) => add(a, rat(BigInt(e.exact.n), BigInt(e.exact.d))), rat(0n));
  // Closed form: 3/2 * [t/2 + t^2/6 + t^3/21]_0^7 = 3/2 * (7/2 + 49/6 + 49/3) = 3/2 * 28 = 42.
  assert.equal(toString(total), '42');
  assert.ok(Math.abs(Number(total.n) / Number(total.d) - bruteTotal) < 1e-5);
  assert.ok(l.verify(cert).ok);
});

// Rounding: only posted amounts are rounded to cents; error <= intervals * half cent.
test('rounding error bound: sum |exact - posted| <= segments * half cent', () => {
  const l = makeLedger([
    { from: 0, to: 3, coefs: [[1, 3]] },
    { from: 3, to: 6, coefs: [[1, 7]] },
    { from: 6, to: 9, coefs: [[1, 11]] },
  ]);
  l.post({ day: 0, amountNum: 1, amountDen: 1 });
  const cert = l.certify({ from: 0, to: 9 });
  let totalResidual = rat(0n);
  for (const iv of cert.intervals) {
    const r = sub(rat(BigInt(iv.exact.n), BigInt(iv.exact.d)), rat(BigInt(iv.postedCents), 100n));
    assert.ok(cmp(abs(r), rat(1n, 200n)) <= 0, 'per-interval residual within half a cent');
    totalResidual = add(totalResidual, r);
  }
  assert.ok(cmp(abs(totalResidual), rat(3n, 200n)) <= 0, 'total residual within segments * half cent');
  assert.ok(l.verify(cert).ok);
});

// Error codes.
test('E_SEG on overlapping segments', () => {
  const l = new Ledger();
  assert.throws(
    () => l.loadCurve({ segments: [{ from: 0, to: 3, coefs: [[1, 1]] }, { from: 2, to: 5, coefs: [[1, 1]] }] }),
    (e) => e.code === 'E_SEG',
  );
});

test('E_DAY on out-of-range post and unknown undo', () => {
  const l = makeLedger();
  assert.throws(() => l.post({ day: 9, amountNum: 1 }), (e) => e.code === 'E_DAY');
  assert.throws(() => l.post({ day: -1, amountNum: 1 }), (e) => e.code === 'E_DAY');
  assert.throws(() => l.undoPost({ id: 999 }), (e) => e.code === 'E_DAY');
  assert.throws(() => l.backdate({ day: 2, newAmount: 5 }), (e) => e.code === 'E_DAY');
});

test('E_PENDING on uncovered certify range, never a zero', () => {
  const l = makeLedger();
  l.post({ day: 0, amountNum: 1, amountDen: 1 });
  assert.throws(() => l.certify({ from: 0, to: 10 }), (e) => e.code === 'E_PENDING');
  assert.throws(() => l.certify({ from: 4, to: 6 }), (e) => e.code === 'E_PENDING');
});

test('E_CERT on tampered certificate', () => {
  const l = makeLedger();
  l.post({ day: 0, amountNum: 7, amountDen: 1 });
  const cert = l.certify({ from: 0, to: 4 });
  const tampered = JSON.parse(JSON.stringify(cert));
  tampered.days[0].exact.n = '999';
  assert.throws(() => l.verify(tampered), (e) => e.code === 'E_CERT');
  const tampered2 = JSON.parse(JSON.stringify(cert));
  tampered2.intervals[0].postedCents = '1';
  assert.throws(() => l.verify(tampered2), (e) => e.code === 'E_CERT');
});

// Cross-segment correction only recomputes affected subintervals.
test('backdate only recomputes days from the correction onward', () => {
  const l = makeLedger([{ from: 0, to: 10, coefs: [[1, 1]] }]);
  l.post({ day: 0, amountNum: 1, amountDen: 1 });
  l.post({ day: 5, amountNum: 2, amountDen: 1 });
  l.certify({ from: 0, to: 10 });
  assert.equal(l.cache.size, 10);
  l.backdate({ day: 5, newAmount: 3 });
  assert.equal(l.cache.size, 5, 'days 0..4 stay cached');
  const cert = l.certify({ from: 0, to: 10 });
  assert.equal(cert.stats.daysComputed, 5, 'only days 5..9 recomputed');
  assert.ok(l.verify(cert).ok);
});
