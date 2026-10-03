import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Inspector } from '../src/inspector.js';

const SQUARE = [
  ['0', '0'],
  ['10', '0'],
  ['10', '10'],
  ['0', '10'],
];

function makeInspector(precision = 3) {
  return new Inspector({ polygon: SQUARE, precision });
}

test('non-convex tolerance zone raises E_GEOMETRY at construction', () => {
  const concave = [['0', '0'], ['10', '0'], ['10', '10'], ['5', '3'], ['0', '10']];
  assert.throws(() => new Inspector({ polygon: concave }), (e) => e.code === 'E_GEOMETRY');
});

test('zero denominator in input raises E_RATIONAL', () => {
  const insp = makeInspector();
  assert.throws(() => insp.addPoint('p1', ['1/0', '2'], ['0', '1']), (e) => e.code === 'E_RATIONAL');
});

test('addPoint judges with identity correction and formats exact/display/rounding', () => {
  const insp = makeInspector(2);
  const r = insp.addPoint('a', ['1/3', '2'], ['1', '3/2']);
  assert.equal(r.judgment.status, 'conforming');
  assert.deepEqual(r.judgment.box.x.exact, { lo: '1/3', hi: '2' });
  assert.deepEqual(r.judgment.box.x.display, { lo: '0.33', hi: '2.00' });
  assert.deepEqual(r.judgment.box.y.display, { lo: '1.00', hi: '1.50' });
  assert.equal(r.judgment.rounding.precision, 2);
  assert.equal(r.judgment.rounding.errorBound, '1/200');
});

test('undo/redo restores incremental state', () => {
  const insp = makeInspector();
  insp.addPoint('a', ['1', '2'], ['1', '2']);
  insp.addPoint('b', ['3', '4'], ['3', '4']);
  assert.equal(insp.points.size, 2);
  assert.deepEqual(insp.undo(), { changed: true });
  assert.equal(insp.points.size, 1);
  assert.throws(() => insp.getJudgment('b'), (e) => e.code === 'E_POINT');
  assert.deepEqual(insp.redo(), { changed: true });
  assert.equal(insp.points.size, 2);
  assert.equal(insp.getJudgment('b').status, 'conforming');
  insp.undo();
  insp.undo();
  assert.equal(insp.points.size, 0);
  assert.deepEqual(insp.undo(), { changed: false });
});

test('acceptance 3: quadratic vertex flips a point from uncertain to nonconforming', () => {
  const insp = makeInspector();
  // v1: shift by +4 -> x interval [6,10] maps to [10,14], crossing edge x=10
  insp.defineCorrection('v1', { x: ['4', '1'], y: ['0', '1'] });
  insp.useCorrection('v1');
  const r1 = insp.addPoint('m', ['6', '10'], ['1', '2']);
  assert.equal(r1.judgment.status, 'uncertain');

  // v2: p(t) = (t-8)^2 + 20 = 84 - 16t + t^2, vertex t=8 inside [6,10],
  // p(8)=20, p(6)=p(10)=24 -> mapped x box [20,24] lies fully outside.
  insp.defineCorrection('v2', { x: ['84', '-16', '1'], y: ['0', '1'] });
  insp.useCorrection('v2');
  const j2 = insp.getJudgment('m');
  assert.equal(j2.status, 'nonconforming');
  // the exact range proves the vertex value 20 was included
  assert.deepEqual(j2.box.x.exact, { lo: '20', hi: '24' });
});

test('acceptance 4: illegal interval rolls the transaction back', () => {
  const insp = makeInspector();
  insp.addPoint('good', ['1', '2'], ['1', '2']);
  const before = insp.getJudgment('good');
  const undoDepth = insp.undoStack.length;
  assert.throws(() => insp.addPoint('bad', ['5', '2'], ['0', '1']), (e) => e.code === 'E_INTERVAL');
  // state untouched: previous point and judgment intact, no new point, no extra undo entry
  assert.equal(insp.points.size, 1);
  assert.deepEqual(insp.getJudgment('good'), before);
  assert.equal(insp.undoStack.length, undoDepth);
  assert.throws(() => insp.getJudgment('bad'), (e) => e.code === 'E_POINT');
});

test('failed correction does not change recorded judgments', () => {
  const insp = makeInspector();
  insp.addPoint('p', ['8', '12'], ['1', '2']);
  const before = insp.getJudgment('p');
  assert.equal(before.status, 'uncertain');
  // invalid polynomial (degree 3) must fail and leave everything untouched
  assert.throws(
    () => insp.defineCorrection('bad', { x: ['0', '0', '0', '1'], y: ['0', '1'] }),
    (e) => e.code === 'E_CORRECTION'
  );
  // unknown version must fail and leave everything untouched
  assert.throws(() => insp.useCorrection('nope'), (e) => e.code === 'E_CORRECTION');
  // zero denominator inside coefficients -> E_RATIONAL, still untouched
  assert.throws(
    () => insp.defineCorrection('bad2', { x: ['1/0', '1'], y: ['0', '1'] }),
    (e) => e.code === 'E_RATIONAL'
  );
  assert.deepEqual(insp.getJudgment('p'), before);
});

test('switching correction versions re-judges all recorded points', () => {
  const insp = makeInspector();
  insp.defineCorrection('shift', { x: ['20', '1'], y: ['0', '1'] });
  insp.addPoint('a', ['1', '2'], ['1', '2']);
  insp.addPoint('b', ['3', '4'], ['3', '4']);
  assert.equal(insp.getJudgment('a').status, 'conforming');
  insp.useCorrection('shift');
  assert.equal(insp.getJudgment('a').status, 'nonconforming');
  assert.equal(insp.getJudgment('b').status, 'nonconforming');
  insp.undo(); // undo useCorrection
  assert.equal(insp.getJudgment('a').status, 'conforming');
});
