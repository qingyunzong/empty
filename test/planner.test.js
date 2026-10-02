import test from 'node:test';
import assert from 'node:assert/strict';
import { Planner, CncError } from '../src/planner.js';

const PARAMS = { k: 3, slot: '1/2', segmentTolerance: '1/10', totalTolerance: '1/2' };

function editWith(segments, params = PARAMS) {
  return { segments, params };
}

function assertCode(err, code) {
  assert.ok(err instanceof CncError, `expected CncError, got ${err}`);
  assert.equal(err.code, code);
  return true;
}

test('successful commit produces certificate with exact and quantized data', () => {
  const planner = new Planner();
  const cert = planner.commit(editWith([
    { coeffs: ['1'], a: '0', b: '2' },
    { coeffs: ['1', '0', '0', '0', '0', '1'], a: '0', b: '1' }, // t^5 + 1
  ]));
  assert.equal(cert.segments.length, 2);
  assert.equal(cert.segments[0].exactIntegral, '2');
  assert.equal(cert.segments[0].slots.length, 4);
  assert.equal(cert.segments[0].slots[0].exact, '1/2');
  assert.equal(cert.segments[0].slots[0].quantized, '1/2');
  assert.equal(cert.segments[0].slots[0].absError, '0');
  assert.equal(cert.segments[0].slots[0].errorBound, '1/2000');
  assert.equal(cert.segments[0].cumulativeAbsError, '0');
  assert.equal(cert.segments[0].cumulativeErrorBound, '1/500');
  assert.equal(cert.segments[1].exactIntegral, '7/6');
  assert.equal(cert.segments[1].degree, 5);
  assert.equal(cert.totalExactIntegral, '19/6');
  assert.equal(cert.params.unit, '1/1000');
});

test('acceptance 2: error exactly equal to tolerance passes', () => {
  // k=0 (unit 1), v = 1/2 on [0,1], one slot: quantized 1, error exactly 1/2.
  const planner = new Planner();
  const cert = planner.commit(editWith(
    [{ coeffs: ['1/2'], a: '0', b: '1' }],
    { k: 0, slot: '1', segmentTolerance: '1/2', totalTolerance: '1/2' },
  ));
  assert.equal(cert.segments[0].cumulativeAbsError, '1/2');
  assert.equal(cert.cumulativeAbsError, '1/2');

  // Two such segments: total error exactly 1 equals total tolerance 1.
  const planner2 = new Planner();
  const cert2 = planner2.commit(editWith(
    [
      { coeffs: ['1/2'], a: '0', b: '1' },
      { coeffs: ['1/2'], a: '0', b: '1' },
    ],
    { k: 0, slot: '1', segmentTolerance: '1/2', totalTolerance: '1' },
  ));
  assert.equal(cert2.cumulativeAbsError, '1');
});

test('error just above tolerance fails with E_TOLERANCE and no trajectory', () => {
  const planner = new Planner();
  planner.commit(editWith([{ coeffs: ['1'], a: '0', b: '1' }]));
  const before = planner.certificate;

  // Segment tolerance 2/5 < 1/2 error.
  assert.throws(
    () => planner.commit(editWith(
      [{ coeffs: ['1/2'], a: '0', b: '1' }],
      { k: 0, slot: '1', segmentTolerance: '2/5', totalTolerance: '1' },
    )),
    (err) => assertCode(err, 'E_TOLERANCE'),
  );
  // Total tolerance 1/3 < 1/2 error.
  assert.throws(
    () => planner.commit(editWith(
      [{ coeffs: ['1/2'], a: '0', b: '1' }],
      { k: 0, slot: '1', segmentTolerance: '1', totalTolerance: '1/3' },
    )),
    (err) => assertCode(err, 'E_TOLERANCE'),
  );
  // Rollback: certificate unchanged, no trajectory generated.
  assert.deepEqual(planner.certificate, before);
});

test('acceptance 3: negative velocity rolls back the whole transaction', () => {
  const planner = new Planner();
  planner.commit(editWith([{ coeffs: ['1'], a: '0', b: '1' }]));
  const before = planner.certificate;

  const badEdits = [
    // Interior dip with positive endpoints: (t - 1/4)(t - 3/4).
    [{ coeffs: ['3/16', '-1', '1'], a: '0', b: '1' }],
    // Negative at the window start.
    [{ coeffs: ['-1', '2'], a: '0', b: '1' }],
    // Good first segment, bad second segment: still a full rollback.
    [{ coeffs: ['1'], a: '0', b: '1' }, { coeffs: ['0', '-2', '1'], a: '0', b: '2' }],
  ];
  for (const segments of badEdits) {
    assert.throws(
      () => planner.commit(editWith(segments)),
      (err) => assertCode(err, 'E_NEGATIVE_VELOCITY'),
    );
    assert.deepEqual(planner.certificate, before);
  }
});

test('velocity touching zero is accepted', () => {
  const planner = new Planner();
  const cert = planner.commit(editWith([{ coeffs: ['1/4', '-1', '1'], a: '0', b: '1' }]));
  assert.equal(cert.segments[0].exactIntegral, '1/12');
});

test('invalid segments and quantization params roll back', () => {
  const planner = new Planner();
  planner.commit(editWith([{ coeffs: ['1'], a: '0', b: '1' }]));
  const before = planner.certificate;

  const cases = [
    [editWith([{ coeffs: ['1'], a: '1', b: '1' }]), 'E_INVALID_SEGMENT'], // a >= b
    [editWith([{ coeffs: ['1'], a: '2', b: '1' }]), 'E_INVALID_SEGMENT'], // a > b
    [editWith([{ coeffs: ['1', '0', '0', '0', '0', '0', '1'], a: '0', b: '1' }]), 'E_INVALID_SEGMENT'], // degree 6
    [editWith([{ coeffs: [], a: '0', b: '1' }]), 'E_INVALID_SEGMENT'],
    [editWith([{ coeffs: ['1'], a: '0', b: '1' }], { ...PARAMS, k: -1 }), 'E_INVALID_QUANTIZATION'],
    [editWith([{ coeffs: ['1'], a: '0', b: '1' }], { ...PARAMS, k: 2.5 }), 'E_INVALID_QUANTIZATION'],
    [editWith([{ coeffs: ['1'], a: '0', b: '1' }], { ...PARAMS, slot: '0' }), 'E_INVALID_QUANTIZATION'],
    [editWith([{ coeffs: ['1'], a: '0', b: '1' }], { ...PARAMS, slot: '-1/2' }), 'E_INVALID_QUANTIZATION'],
    [editWith([{ coeffs: ['1'], a: '0', b: '1' }], { ...PARAMS, segmentTolerance: '-1' }), 'E_INVALID_TOLERANCE'],
  ];
  for (const [edit, code] of cases) {
    assert.throws(() => planner.commit(edit), (err) => assertCode(err, code));
    assert.deepEqual(planner.certificate, before);
  }
});

test('acceptance 4: undo restores the previous certificate, redo reapplies', () => {
  const planner = new Planner();
  const certA = planner.commit(editWith([{ coeffs: ['1'], a: '0', b: '1' }]));
  const certB = planner.commit(editWith([
    { coeffs: ['1'], a: '0', b: '1' },
    { coeffs: ['2', '1'], a: '0', b: '1' },
  ]));
  assert.notDeepEqual(certA, certB);

  assert.deepEqual(planner.undo(), certA); // certificate restored
  assert.deepEqual(planner.certificate, certA);
  assert.deepEqual(planner.redo(), certB);
  assert.deepEqual(planner.certificate, certB);

  planner.undo();
  planner.undo(); // back to the empty initial state
  assert.equal(planner.certificate.segments.length, 0);
  assert.throws(() => planner.undo(), (err) => assertCode(err, 'E_UNDO_EMPTY'));
  planner.redo();
  assert.deepEqual(planner.certificate, certA);
  planner.redo();
  assert.throws(() => planner.redo(), (err) => assertCode(err, 'E_REDO_EMPTY'));
});

test('new commit after undo discards the redo branch', () => {
  const planner = new Planner();
  planner.commit(editWith([{ coeffs: ['1'], a: '0', b: '1' }]));
  planner.commit(editWith([{ coeffs: ['2'], a: '0', b: '1' }]));
  planner.undo();
  const certC = planner.commit(editWith([{ coeffs: ['3'], a: '0', b: '1' }]));
  assert.equal(certC.totalExactIntegral, '3');
  assert.throws(() => planner.redo(), (err) => assertCode(err, 'E_REDO_EMPTY'));
});

test('multi-slot quantization with exact cumulative accounting', () => {
  const planner = new Planner();
  // v = t on [0, 1], slots of 1/4, k = 1.
  const cert = planner.commit(editWith(
    [{ coeffs: ['0', '1'], a: '0', b: '1' }],
    { k: 1, slot: '1/4', segmentTolerance: '1', totalTolerance: '1' },
  ));
  const seg = cert.segments[0];
  assert.equal(seg.exactIntegral, '1/2');
  assert.deepEqual(
    seg.slots.map((s) => s.exact),
    ['1/32', '3/32', '5/32', '7/32'],
  );
  // 1/32=0.03125 -> 0, 3/32=0.09375 -> 1/10, 5/32=0.15625 -> 2/10, 7/32=0.21875 -> 2/10
  assert.deepEqual(
    seg.slots.map((s) => s.quantized),
    ['0', '1/10', '1/5', '1/5'],
  );
  // 1/32 + 1/160 + 7/160 + 3/160 = 1/10
  assert.equal(seg.cumulativeAbsError, '1/10');
  assert.equal(seg.cumulativeErrorBound, '1/5');
});
