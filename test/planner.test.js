'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Rational } = require('../src/rational');
const { FeedPlanner, quantize } = require('../src/planner');

function makePlanner(overrides = {}) {
  return new FeedPlanner({
    quantumExp: 1,
    slot: '1/2',
    segmentTolerance: '1/10',
    totalTolerance: '1/5',
    ...overrides,
  });
}

function commitSegments(planner, segments) {
  planner.beginEdit();
  for (const seg of segments) planner.addSegment(seg);
  return planner.commit();
}

// Acceptance 1: for degree <= 4 the certificate's exact integral is checked
// against an independent direct monomial summation.
test('acceptance 1: exact integral matches independent monomial summation (degree <= 4)', () => {
  const cases = [
    { coeffs: ['1', '1/2', '1/3', '1/4', '1/5'], a: '1/3', b: '2' },
    { coeffs: ['3', '0', '2', '0', '1/7'], a: '0', b: '3/2' },
    { coeffs: ['2', '-1', '4', '1'], a: '1', b: '5/2' },
    { coeffs: ['7/3'], a: '0', b: '9/4' },
  ];
  for (const { coeffs, a, b } of cases) {
    const planner = makePlanner({ slot: '1/4', segmentTolerance: '100', totalTolerance: '1000' });
    const result = commitSegments(planner, [{ coeffs, a, b }]);
    assert.equal(result.ok, true, JSON.stringify(result));
    // Independent check: sum_i c_i * (b^(i+1) - a^(i+1)) / (i+1).
    const ra = Rational.from(a);
    const rb = Rational.from(b);
    let expected = Rational.zero();
    for (let i = 0; i < coeffs.length; i++) {
      expected = expected.add(
        Rational.from(coeffs[i])
          .mul(rb.pow(i + 1).sub(ra.pow(i + 1)))
          .div(Rational.from(BigInt(i + 1))),
      );
    }
    assert.equal(result.certificate.segments[0].exactIntegral, expected.toString());
  }
});

test('quantization rounds half up at exact halves', () => {
  assert.equal(quantize(Rational.from('3/20'), 1).toString(), '1/5'); // 0.15 -> 0.2
  assert.equal(quantize(Rational.from('1/4'), 1).toString(), '3/10'); // 0.25 -> 0.3
  assert.equal(quantize(Rational.from('-3/20'), 1).toString(), '-1/10'); // half up towards +inf
  assert.equal(quantize(Rational.from('7/40'), 2).toString(), '9/50'); // 0.175 -> 0.18
  assert.equal(quantize(Rational.from('1/8'), 1).toString(), '1/10'); // 0.125 -> 0.1
});

// Acceptance 2: an error exactly equal to the tolerance passes.
test('acceptance 2: error exactly equal to tolerance passes', () => {
  // v = 3/20 constant on [0,1], slot 1, quantumExp 1 -> quantized 1/5,
  // abs error = 1/5 - 3/20 = 1/20 exactly.
  const planner = makePlanner({
    quantumExp: 1,
    slot: '1',
    segmentTolerance: '1/20',
    totalTolerance: '1/20',
  });
  const result = commitSegments(planner, [{ coeffs: ['3/20'], a: '0', b: '1' }]);
  assert.equal(result.ok, true, JSON.stringify(result));
  const seg = result.certificate.segments[0];
  assert.equal(seg.exactIntegral, '3/20');
  assert.equal(seg.quantized, '1/5');
  assert.equal(seg.absError, '1/20');
  assert.equal(seg.absError, planner._state.params.segmentTolerance.toString());
  assert.equal(result.certificate.totalAbsError, '1/20');

  // One quantum less of tolerance must fail with E_TOLERANCE and no trajectory.
  const tight = makePlanner({
    quantumExp: 1,
    slot: '1',
    segmentTolerance: '1/21',
    totalTolerance: '1/20',
  });
  const failed = commitSegments(tight, [{ coeffs: ['3/20'], a: '0', b: '1' }]);
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'E_TOLERANCE');
  assert.equal(tight.certificate().segmentCount, 0, 'no trajectory may be generated');
});

test('per-segment and cross-segment tolerance enforcement', () => {
  // Two segments each with abs error 1/20; segment tolerance 1/10 passes each,
  // total tolerance 1/20 is exceeded by the cumulative 1/10.
  const planner = makePlanner({
    quantumExp: 1,
    slot: '1',
    segmentTolerance: '1/10',
    totalTolerance: '1/20',
  });
  const result = commitSegments(planner, [
    { coeffs: ['3/20'], a: '0', b: '1' },
    { coeffs: ['3/20'], a: '1', b: '2' },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'E_TOLERANCE');
  assert.equal(planner.certificate().segmentCount, 0);
});

// Acceptance 3: a segment with negative velocity rolls back the whole edit.
test('acceptance 3: negative velocity rolls back the entire transaction', () => {
  const planner = makePlanner();
  const good = commitSegments(planner, [{ coeffs: ['1'], a: '0', b: '1' }]);
  assert.equal(good.ok, true);
  const before = planner.certificate();

  const result = commitSegments(planner, [
    { coeffs: ['2'], a: '1', b: '2' }, // fine
    { coeffs: ['5/2', '-1'], a: '2', b: '3' }, // v = 5/2 - t < 0 on (2.5, 3]
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'E_NEGATIVE_VELOCITY');
  assert.deepEqual(planner.certificate(), before, 'state must be rolled back');
  assert.equal(planner.certificate().segmentCount, 1);
});

test('invalid interval and invalid quantum roll back / are rejected', () => {
  const planner = makePlanner();
  const badInterval = commitSegments(planner, [{ coeffs: ['1'], a: '1', b: '1' }]);
  assert.equal(badInterval.ok, false);
  assert.equal(badInterval.code, 'E_INVALID_INTERVAL');

  const reversed = commitSegments(planner, [{ coeffs: ['1'], a: '2', b: '1' }]);
  assert.equal(reversed.code, 'E_INVALID_INTERVAL');

  assert.throws(() => new FeedPlanner({ quantumExp: -1, slot: '1', segmentTolerance: '1', totalTolerance: '1' }), /quantumExp/);
  assert.throws(() => new FeedPlanner({ quantumExp: 1.5, slot: '1', segmentTolerance: '1', totalTolerance: '1' }), /quantumExp/);

  planner.beginEdit();
  planner.setParams({ quantumExp: -3 });
  const badQuantum = planner.commit();
  assert.equal(badQuantum.ok, false);
  assert.equal(badQuantum.code, 'E_INVALID_QUANTUM');
  assert.equal(planner.certificate().segmentCount, 0);
});

test('degree above 5 is rejected', () => {
  const planner = makePlanner();
  const result = commitSegments(planner, [{ coeffs: ['1', '0', '0', '0', '0', '0', '1'], a: '0', b: '1' }]);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'E_DEGREE');
});

// Acceptance 4: undo restores the previous certificate; redo replays it.
test('acceptance 4: undo restores the certificate, redo replays it', () => {
  const planner = makePlanner({ slot: '1/4', segmentTolerance: '1', totalTolerance: '10' });
  const initial = planner.certificate();

  const first = commitSegments(planner, [{ coeffs: ['1', '1/2'], a: '0', b: '1' }]);
  assert.equal(first.ok, true);
  const certAfterFirst = planner.certificate();

  const second = commitSegments(planner, [{ coeffs: ['2'], a: '1', b: '3/2' }]);
  assert.equal(second.ok, true);
  const certAfterSecond = planner.certificate();
  assert.notDeepEqual(certAfterSecond, certAfterFirst);

  assert.equal(planner.undo().ok, true);
  assert.deepEqual(planner.certificate(), certAfterFirst, 'undo must restore the certificate');

  assert.equal(planner.undo().ok, true);
  assert.deepEqual(planner.certificate(), initial);

  assert.equal(planner.redo().ok, true);
  assert.deepEqual(planner.certificate(), certAfterFirst);
  assert.equal(planner.redo().ok, true);
  assert.deepEqual(planner.certificate(), certAfterSecond);

  // A new commit clears the redo stack.
  planner.undo();
  commitSegments(planner, [{ coeffs: ['1'], a: '1', b: '2' }]);
  assert.equal(planner.redo().ok, false);
});

test('failed commit does not touch undo history', () => {
  const planner = makePlanner();
  commitSegments(planner, [{ coeffs: ['1'], a: '0', b: '1' }]);
  const cert = planner.certificate();
  const failed = commitSegments(planner, [{ coeffs: ['-1'], a: '1', b: '2' }]);
  assert.equal(failed.ok, false);
  assert.deepEqual(planner.certificate(), cert);
  assert.equal(planner.undo().ok, true);
  assert.equal(planner.certificate().segmentCount, 0);
});

test('certificate reports exact integral, quantized value, strict bounds and cumulative bounds', () => {
  const planner = makePlanner({ quantumExp: 2, slot: '1/2', segmentTolerance: '1', totalTolerance: '10' });
  const result = commitSegments(planner, [
    { coeffs: ['1', '1/2'], a: '0', b: '1' },
    { coeffs: ['2'], a: '1', b: '2' },
  ]);
  assert.equal(result.ok, true);
  const cert = result.certificate;
  assert.equal(cert.quantum, '1/100');
  assert.equal(cert.segments.length, 2);
  const [s0, s1] = cert.segments;
  assert.equal(s0.exactIntegral, '5/4');
  assert.equal(s0.errorBound, '1/100'); // 2 slots * (1/2 * 1/100)
  assert.equal(s0.cumulativeErrorBound, '1/100');
  assert.equal(s1.exactIntegral, '2');
  assert.equal(s1.errorBound, '1/100'); // 2 slots * (1/2 * 1/100)
  assert.equal(s1.cumulativeErrorBound, '1/50');
  assert.equal(cert.totalErrorBound, '1/50');
  // Slot-level strict bound: -u/2 < err <= u/2 with u = 1/100.
  for (const slot of s0.slots.concat(s1.slots)) {
    assert.equal(slot.errorBound, '1/200');
    const err = Rational.from(slot.signedError);
    assert.ok(err.cmp(Rational.from('-1/200')) > 0);
    assert.ok(err.cmp(Rational.from('1/200')) <= 0);
  }
});

test('unaligned segment intervals clip to the fixed slot grid', () => {
  const planner = makePlanner({ quantumExp: 3, slot: '1/4', segmentTolerance: '1', totalTolerance: '10' });
  const result = commitSegments(planner, [{ coeffs: ['1'], a: '1/8', b: '1/2' }]);
  assert.equal(result.ok, true);
  const slots = result.certificate.segments[0].slots;
  assert.deepEqual(slots.map((s) => s.interval), [['1/8', '1/4'], ['1/4', '1/2']]);
  assert.equal(slots[0].exact, '1/8');
  assert.equal(slots[1].exact, '1/4');
});
