'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Ledger, InterestError } = require('../src/ledger');
const { Curve } = require('../src/curve');
const { Frac } = require('../src/rational');

function ledgerWithCurve(segments) {
  const ledger = new Ledger();
  ledger.loadCurve({ segments });
  return ledger;
}

test('1. two-segment polynomial matches hand-computed integral', () => {
  // r(t) = 1 on [0,2); r(t) = t/2 on [2,5).
  // Hand: integral = 1*(2-0) + [t^2/4]2..5 = 2 + (25-4)/4 = 2 + 21/4 = 29/4.
  // Amount 1000 posted at day 0 => exact interest = 1000 * 29/4 = 7250.
  const ledger = ledgerWithCurve([
    { from: 0, to: 2, coefs: [[1, 1]] },
    { from: 2, to: 5, coefs: [[0, 1], [1, 2]] },
  ]);
  ledger.post({ day: 0, amountNum: 1000, amountDen: 1 });
  const cert = ledger.certify({ from: 0, to: 5 });
  assert.equal(cert.exactTotal, '7250');
  assert.equal(cert.bookedTotal, '7250');
  assert.equal(cert.residual, '0');
  assert.equal(cert.subintervals.length, 2);
  assert.deepEqual(
    cert.subintervals.map((s) => [s.from, s.to, s.exact]),
    [
      [0, 2, '2000'],
      [2, 5, '5250'],
    ]
  );
});

test('1b. rounding happens only at booking, residual within half a cent per segment', () => {
  // r(t) = 1/3 on [0,1); amount 1 => exact 1/3, booked 33/100, residual 1/300.
  const ledger = ledgerWithCurve([{ from: 0, to: 1, coefs: [[1, 3]] }]);
  ledger.post({ day: 0, amountNum: 1, amountDen: 1 });
  const cert = ledger.certify({ from: 0, to: 1 });
  assert.equal(cert.exactTotal, '1/3');
  assert.equal(cert.bookedTotal, '33/100');
  assert.equal(cert.residual, '1/300');
  assert.equal(cert.errorBound, '1/200'); // one segment * half a cent
  assert.equal(cert.endpointResiduals.from, '1/300');
  assert.equal(cert.endpointResiduals.to, '1/300');
  assert.ok(new Frac(1n, 300n).cmp(new Frac(1n, 200n)) <= 0);
});

test('2. backdate invalidates old certificate, new certificate verifies', () => {
  const ledger = ledgerWithCurve([{ from: 0, to: 7, coefs: [[1, 10]] }]);
  ledger.post({ day: 1, amountNum: 500, amountDen: 1 });
  const cert1 = ledger.certify({ from: 0, to: 7 });
  assert.equal(cert1.exactTotal, '300'); // 500 * 6 days * 1/10
  assert.deepEqual(ledger.verify({ certId: cert1.id }), {
    ok: true,
    certId: cert1.id,
    root: cert1.root,
    exactTotal: '300',
    bookedTotal: '300',
    residual: '0',
    errorBound: '1/200',
  });

  ledger.backdate({ day: 1, newAmount: [600, 1] });
  assert.throws(
    () => ledger.verify({ certId: cert1.id }),
    (e) => e instanceof InterestError && e.code === 'E_CERT'
  );

  const cert2 = ledger.certify({ from: 0, to: 7 });
  assert.equal(cert2.exactTotal, '360'); // 600 * 6 * 1/10
  assert.notEqual(cert2.root, cert1.root);
  assert.equal(ledger.verify({ certId: cert2.id }).ok, true);
});

test('2b. backdate recomputes only the affected integral sub-intervals', () => {
  const ledger = ledgerWithCurve([
    { from: 0, to: 3, coefs: [[1, 10]] },
    { from: 3, to: 6, coefs: [[1, 5]] },
  ]);
  ledger.post({ day: 0, amountNum: 100, amountDen: 1 });
  ledger.post({ day: 1, amountNum: 200, amountDen: 1 });
  const cert1 = ledger.certify({ from: 0, to: 6 });
  assert.equal(cert1.stats.subintervals, 4);
  assert.equal(cert1.stats.recomputed, 4);
  assert.equal(cert1.stats.reused, 0);

  ledger.backdate({ day: 0, newAmount: 150 });
  const cert2 = ledger.certify({ from: 0, to: 6 });
  // Only the two sub-intervals of the corrected posting are recomputed.
  assert.equal(cert2.stats.recomputed, 2);
  assert.equal(cert2.stats.reused, 2);
  assert.equal(ledger.verify({ certId: cert2.id }).ok, true);
});

test('3. undoPost restores the previous Merkle root', () => {
  const ledger = ledgerWithCurve([{ from: 0, to: 5, coefs: [[1, 10]] }]);
  ledger.post({ day: 0, amountNum: 100, amountDen: 1 });
  const rootBefore = ledger.root();
  const { id } = ledger.post({ day: 2, amountNum: 50, amountDen: 1 });
  assert.notEqual(ledger.root(), rootBefore);
  ledger.undoPost({ id });
  assert.equal(ledger.root(), rootBefore);
});

test('4. brute-force daily summation matches certificate for N <= 7 days', () => {
  const segments = [
    { from: 0, to: 3, coefs: [[1, 5], [1, 10]] }, // 1/5 + t/10
    { from: 3, to: 5, coefs: [[2, 1]] }, // 2
    { from: 5, to: 7, coefs: [[1, 2], [0, 1], [1, 4]] }, // 1/2 + t^2/4
  ];
  const ledger = ledgerWithCurve(segments);
  ledger.post({ day: 0, amountNum: 1000, amountDen: 3 });
  ledger.post({ day: 2, amountNum: 77, amountDen: 1 });
  ledger.post({ day: 5, amountNum: 1, amountDen: 7 });

  const curve = new Curve(segments);
  const postings = [
    { day: 0, amount: new Frac(1000n, 3n) },
    { day: 2, amount: new Frac(77n) },
    { day: 5, amount: new Frac(1n, 7n) },
  ];

  for (let n = 1; n <= 7; n++) {
    const cert = ledger.certify({ from: 0, to: n });
    // Brute force: day-by-day exact integration, no caching, no segments.
    let brute = new Frac(0n);
    for (let d = 0; d < n; d++) {
      const si = curve.segmentAt(d);
      assert.notEqual(si, -1);
      const dayIntegral = curve.segments[si].integrate(d, d + 1);
      for (const p of postings) {
        if (p.day <= d) brute = brute.add(p.amount.mul(dayIntegral));
      }
    }
    assert.equal(cert.exactTotal, brute.toString(), `N=${n}`);
    // Error bound: |exact - booked| <= segmentsInvolved * half a cent.
    const residual = new Frac(BigInt(cert.residual.split('/')[0]), BigInt(cert.residual.split('/')[1] || 1));
    const bound = new Frac(BigInt(cert.segmentsInvolved), 200n);
    assert.ok(residual.abs().cmp(bound) <= 0, `N=${n} residual ${cert.residual} within ${bound}`);
    assert.equal(ledger.verify({ certId: cert.id }).ok, true);
  }
});

test('error codes: E_SEG, E_DAY, E_PENDING, E_CERT', () => {
  const ledger = new Ledger();
  assert.throws(
    () =>
      ledger.loadCurve({
        segments: [
          { from: 0, to: 5, coefs: [[1, 1]] },
          { from: 4, to: 9, coefs: [[1, 1]] },
        ],
      }),
    (e) => e.code === 'E_SEG'
  );

  ledger.loadCurve({ segments: [{ from: 0, to: 7, coefs: [[1, 10]] }] });
  assert.throws(() => ledger.post({ day: 9, amountNum: 1, amountDen: 1 }), (e) => e.code === 'E_DAY');
  assert.throws(() => ledger.backdate({ day: 3, newAmount: 1 }), (e) => e.code === 'E_DAY');
  assert.throws(() => ledger.undoPost({ id: 999 }), (e) => e.code === 'E_DAY');

  // Uncovered range must report E_PENDING, never a silent zero.
  assert.throws(
    () => ledger.certify({ from: 0, to: 10 }),
    (e) => e.code === 'E_PENDING' && JSON.stringify(e.details.uncovered) === '[[7,10]]'
  );

  assert.throws(() => ledger.verify({ certId: 'cert-404' }), (e) => e.code === 'E_CERT');
});
