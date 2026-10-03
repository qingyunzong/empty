import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from '../src/cli-core.js';

function run(input) {
  const { text, code } = runCli(typeof input === 'string' ? input : JSON.stringify(input));
  const lines = text.split('\n').filter(Boolean);
  assert.equal(lines.length, 1, `stdout must be a single JSON line, got: ${text}`);
  return { code, out: JSON.parse(lines[0]) };
}

const SQUARE = [[0, 0], [1, 0], [1, 1], [0, 1]];

test('batch commands produce single-line JSON and exit 0', () => {
  const { code, out } = run({
    commands: [
      { op: 'setTolerance', polygon: SQUARE },
      { op: 'addPoint', id: 'a', x: ['1/4', '1/2'], y: ['1/4', '1/2'] },
      { op: 'addPoint', id: 'b', x: ['1/2', '3/2'], y: ['1/2', '1/2'] },
      { op: 'addPoint', id: 'c', x: ['2', '3'], y: ['2', '3'] },
      { op: 'getState', decimals: 2 },
    ],
  });
  assert.equal(code, 0);
  assert.equal(out.ok, true);
  assert.equal(out.results.length, 5);
  assert.equal(out.results[1].judgment.classification, 'conforming');
  assert.equal(out.results[2].judgment.classification, 'uncertain');
  assert.equal(out.results[3].judgment.classification, 'nonconforming');
  const state = out.results[4].state;
  assert.equal(state.points.length, 3);
  assert.equal(state.points[0].rounding.errorBound, '1/200');
});

test('correction switch, undo and redo work through the CLI', () => {
  const { code, out } = run([
    { op: 'setTolerance', polygon: SQUARE },
    { op: 'addPoint', id: 'p', x: ['1/2', '3/2'], y: ['1/2', '1/2'] },
    { op: 'setCorrection', version: 'quad', x: ['3', '-2', '1'], y: ['0', '1'] },
    { op: 'undo' },
    { op: 'getState' },
    { op: 'redo' },
    { op: 'getState' },
  ]);
  assert.equal(code, 0);
  assert.equal(out.results[2].classifications.p, 'nonconforming');
  assert.equal(out.results[4].state.points[0].classification, 'uncertain');
  assert.equal(out.results[6].state.points[0].classification, 'nonconforming');
});

test('non-convex polygon yields E_GEOMETRY, single-line output, exit 1', () => {
  const { code, out } = run({
    commands: [{ op: 'setTolerance', polygon: [[0, 0], [4, 0], [4, 4], [2, 2], [0, 4]] }],
  });
  assert.equal(code, 1);
  assert.equal(out.ok, false);
  assert.equal(out.error.code, 'E_GEOMETRY');
});

test('zero denominator yields E_RATIONAL and prior results are kept', () => {
  const { code, out } = run([
    { op: 'setTolerance', polygon: SQUARE },
    { op: 'addPoint', id: 'ok1', x: ['0', '1/2'], y: ['0', '1/2'] },
    { op: 'addPoint', id: 'bad', x: ['1/0', '1'], y: ['0', '1'] },
    { op: 'getState' },
  ]);
  assert.equal(code, 1);
  assert.equal(out.ok, false);
  assert.equal(out.error.code, 'E_RATIONAL');
  assert.equal(out.results.length, 2); // getState never ran
});

test('invalid interval yields E_INTERVAL with exit 1', () => {
  const { code, out } = run([
    { op: 'setTolerance', polygon: SQUARE },
    { op: 'addPoint', id: 'bad', x: ['3/4', '1/4'], y: ['0', '1'] },
  ]);
  assert.equal(code, 1);
  assert.equal(out.error.code, 'E_INTERVAL');
});

test('malformed stdin yields E_PARSE with exit 1', () => {
  const { code, out } = run('this is not json');
  assert.equal(code, 1);
  assert.equal(out.ok, false);
  assert.equal(out.error.code, 'E_PARSE');
});

test('a single command object (not wrapped in an array) is accepted', () => {
  const { code, out } = run({ op: 'setTolerance', polygon: SQUARE });
  assert.equal(code, 0);
  assert.equal(out.ok, true);
  assert.equal(out.results[0].toleranceVertices, 4);
});
