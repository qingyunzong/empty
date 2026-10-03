import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runRaw } from '../src/cli.js';

function runCli(input) {
  const payload = typeof input === 'string' ? input : JSON.stringify(input);
  const { output, exitCode } = runRaw(payload);
  const line = JSON.stringify(output);
  assert.equal(line.includes('\n'), false, 'stdout payload must be a single JSON line');
  return { out: JSON.parse(line), code: exitCode };
}

const SQUARE = [
  ['0', '0'],
  ['10', '0'],
  ['10', '10'],
  ['0', '10'],
];

test('CLI processes a full session and emits one JSON line', () => {
  const { out, code } = runCli({
    tolerance: { polygon: SQUARE },
    precision: 2,
    operations: [
      { op: 'addPoint', id: 'a', x: ['1/3', '2'], y: ['1', '2'] },
      { op: 'defineCorrection', version: 'v1', x: ['9', '1'], y: ['0', '1'] },
      { op: 'useCorrection', version: 'v1' },
      { op: 'judge', id: 'a' },
      { op: 'undo' },
      { op: 'judge', id: 'a' },
      { op: 'redo' },
      { op: 'judge', id: 'a' },
    ],
  });
  assert.equal(code, 0);
  assert.equal(out.ok, true);
  assert.equal(out.results.length, 8);
  assert.equal(out.results[0].judgment.status, 'conforming');
  assert.equal(out.results[0].judgment.box.x.display.lo, '0.33');
  assert.equal(out.results[3].judgment.status, 'uncertain'); // shifted x box [28/3, 11] crosses x=10
  assert.equal(out.results[4].changed, true);
  assert.equal(out.results[5].judgment.status, 'conforming');
  assert.equal(out.results[7].judgment.status, out.results[3].judgment.status);
});

test('CLI reports per-operation errors without aborting the batch', () => {
  const { out, code } = runCli({
    tolerance: { polygon: SQUARE },
    operations: [
      { op: 'addPoint', id: 'ok', x: ['1', '2'], y: ['1', '2'] },
      { op: 'addPoint', id: 'bad', x: ['9', '1'], y: ['1', '2'] },
      { op: 'addPoint', id: 'rat', x: ['1/0', '2'], y: ['1', '2'] },
      { op: 'judge', id: 'ok' },
    ],
  });
  assert.equal(code, 0);
  assert.equal(out.results[0].ok, true);
  assert.equal(out.results[1].ok, false);
  assert.equal(out.results[1].error.code, 'E_INTERVAL');
  assert.equal(out.results[2].error.code, 'E_RATIONAL');
  assert.equal(out.results[3].judgment.status, 'conforming');
});

test('CLI rejects non-convex tolerance polygon with E_GEOMETRY', () => {
  const { out, code } = runCli({
    tolerance: { polygon: [['0', '0'], ['10', '0'], ['10', '10'], ['5', '3'], ['0', '10']] },
    operations: [],
  });
  assert.equal(code, 1);
  assert.equal(out.ok, false);
  assert.equal(out.error.code, 'E_GEOMETRY');
});

test('CLI rejects malformed JSON with E_PARSE', () => {
  const { out, code } = runCli('{not json');
  assert.equal(code, 1);
  assert.equal(out.error.code, 'E_PARSE');
});
