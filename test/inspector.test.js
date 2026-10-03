import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Inspector } from '../src/inspector.js';

const SQUARE = [[0, 0], [1, 0], [1, 1], [0, 1]];

function withSquare() {
  const insp = new Inspector();
  insp.setTolerance(SQUARE);
  return insp;
}

test('acceptance 3: quadratic vertex moves point from uncertain to nonconforming', () => {
  const insp = withSquare();
  insp.addPoint({ id: 'p', x: ['1/2', '3/2'], y: ['1/2', '1/2'] });

  // Identity correction: box x in [1/2, 3/2] crosses edge x=1.
  assert.equal(insp.judgment('p').classification, 'uncertain');

  // X = (x-1)^2 + 2 has vertex t=1 inside [1/2, 3/2]; image is [2, 9/4],
  // entirely right of the unit square. Endpoints alone would give only 9/4.
  insp.setCorrection({ version: 'quad', x: ['3', '-2', '1'], y: ['0', '1'] });
  const j = insp.judgment('p');
  assert.equal(j.classification, 'nonconforming');
  assert.equal(j.correctionVersion, 'quad');
  assert.equal(j.exact.x.min, '2');
  assert.equal(j.exact.x.max, '9/4');
  assert.deepEqual(j.stationaryPoints.x, { t: '1', value: '2' });

  // Undoing the correction restores the recorded uncertain judgment.
  insp.undo();
  assert.equal(insp.judgment('p').classification, 'uncertain');
  insp.redo();
  assert.equal(insp.judgment('p').classification, 'nonconforming');
});

test('acceptance 4: invalid interval rolls the transaction back', () => {
  const insp = withSquare();
  insp.addPoint({ id: 'good', x: ['0', '1/2'], y: ['0', '1/2'] });
  const before = insp.state();

  assert.throws(
    () => insp.addPoint({ id: 'bad', x: ['3/4', '1/4'], y: ['0', '1'] }),
    (e) => e.code === 'E_INTERVAL',
  );
  assert.equal(insp.pointCount, 1);
  assert.deepEqual(insp.state(), before);
  assert.equal(insp.judgment('good').classification, 'conforming');
});

test('zero denominator raises E_RATIONAL and leaves state untouched', () => {
  const insp = withSquare();
  insp.addPoint({ id: 'good', x: ['0', '1/2'], y: ['0', '1/2'] });
  const before = insp.state();

  assert.throws(
    () => insp.addPoint({ id: 'bad', x: ['1/0', '1'], y: ['0', '1'] }),
    (e) => e.code === 'E_RATIONAL',
  );
  assert.throws(() => insp.setTolerance([[0, 0], ['1/0', 0], [1, 1]]), (e) => e.code === 'E_RATIONAL');
  assert.deepEqual(insp.state(), before);
});

test('non-convex tolerance raises E_GEOMETRY and keeps previous tolerance', () => {
  const insp = withSquare();
  insp.addPoint({ id: 'p', x: ['0', '1/2'], y: ['0', '1/2'] });
  const before = insp.state();

  assert.throws(
    () => insp.setTolerance([[0, 0], [4, 0], [4, 4], [2, 2], [0, 4]]),
    (e) => e.code === 'E_GEOMETRY',
  );
  assert.deepEqual(insp.state(), before);
  assert.equal(insp.judgment('p').classification, 'conforming');
});

test('failed correction does not change recorded judgments', () => {
  const insp = withSquare();
  insp.addPoint({ id: 'p', x: ['0', '1/2'], y: ['0', '1/2'] });
  const before = insp.state();

  assert.throws(() => insp.setCorrection({ version: 'broken', x: ['1/0', '1'] }), (e) => e.code === 'E_RATIONAL');
  assert.throws(() => insp.setCorrection({ version: 'broken', x: [1, 2, 3, 4] }), (e) => e.code === 'E_VALIDATION');
  assert.deepEqual(insp.state(), before);
  assert.equal(insp.judgment('p').correctionVersion, 'identity');
});

test('undo/redo walk the mutation history; new mutation clears redo', () => {
  const insp = withSquare();
  insp.addPoint({ id: 'a', x: ['0', '1/4'], y: ['0', '1/4'] });
  insp.addPoint({ id: 'b', x: ['3/4', '1'], y: ['3/4', '1'] });
  assert.equal(insp.pointCount, 2);

  assert.deepEqual(insp.undo(), { changed: true });
  assert.equal(insp.pointCount, 1);
  assert.deepEqual(insp.undo(), { changed: true });
  assert.equal(insp.pointCount, 0);
  assert.deepEqual(insp.redo(), { changed: true });
  assert.deepEqual(insp.redo(), { changed: true });
  assert.equal(insp.pointCount, 2);
  assert.deepEqual(insp.redo(), { changed: false });

  insp.undo();
  insp.addPoint({ id: 'c', x: ['0', '1/4'], y: ['0', '1/4'] });
  assert.deepEqual(insp.redo(), { changed: false });
  assert.equal(insp.pointCount, 2);
});

test('state carries exact range, rounded display, and rounding error bound', () => {
  const insp = withSquare();
  insp.addPoint({ id: 'p', x: ['1/8', '1/3'], y: ['-1/8', '0'] });
  const s = insp.state(2);
  const p = s.points[0];
  assert.equal(p.exact.x.min, '1/8');
  assert.equal(p.exact.x.max, '1/3');
  assert.equal(p.display.x.min, '0.13');
  assert.equal(p.display.x.max, '0.33');
  assert.equal(p.display.y.min, '-0.13');
  assert.equal(p.rounding.errorBound, '1/200');
  assert.equal(p.classification, 'uncertain'); // y dips below the square
  assert.equal(s.correctionVersion, 'identity');
  assert.equal(s.canUndo, true);
});

test('classifications cover all three outcomes', () => {
  const insp = withSquare();
  insp.addPoint({ id: 'in', x: ['1/4', '1/2'], y: ['1/4', '1/2'] });
  insp.addPoint({ id: 'cross', x: ['1/2', '3/2'], y: ['1/2', '1/2'] });
  insp.addPoint({ id: 'out', x: ['2', '3'], y: ['2', '3'] });
  assert.equal(insp.judgment('in').classification, 'conforming');
  assert.equal(insp.judgment('cross').classification, 'uncertain');
  assert.equal(insp.judgment('out').classification, 'nonconforming');
});
