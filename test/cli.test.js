import test from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from '../src/cli-core.js';

function run(input) {
  const text = typeof input === 'string' ? input : JSON.stringify(input);
  const { output, exitCode } = runCli(text);
  const lines = output.trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1, `stdout must be a single JSON line, got: ${output}`);
  return { exitCode, out: JSON.parse(lines[0]) };
}

const COMMIT = {
  op: 'commit',
  segments: [{ coeffs: ['1/2'], a: '0', b: '1' }],
  params: { k: 0, slot: '1', segmentTolerance: '1/2', totalTolerance: '1/2' },
};

test('commit op over stdin/stdout JSON', () => {
  const { exitCode, out } = run({ ops: [COMMIT, { op: 'certificate' }] });
  assert.equal(exitCode, 0);
  assert.equal(out.ok, true);
  assert.equal(out.results.length, 2);
  assert.equal(out.results[0].certificate.segments[0].cumulativeAbsError, '1/2');
  assert.deepEqual(out.results[1].certificate, out.results[0].certificate);
});

test('single op object without ops wrapper', () => {
  const { exitCode, out } = run(COMMIT);
  assert.equal(exitCode, 0);
  assert.equal(out.ok, true);
  assert.equal(out.results.length, 1);
});

test('E_TOLERANCE failure: error code reported, exit code 1', () => {
  const bad = {
    op: 'commit',
    segments: [{ coeffs: ['1/2'], a: '0', b: '1' }],
    params: { k: 0, slot: '1', segmentTolerance: '1/3', totalTolerance: '1' },
  };
  const { exitCode, out } = run({ ops: [bad] });
  assert.equal(exitCode, 1);
  assert.equal(out.ok, false);
  assert.equal(out.results[0].ok, false);
  assert.equal(out.results[0].error.code, 'E_TOLERANCE');
});

test('negative velocity reported as E_NEGATIVE_VELOCITY', () => {
  const bad = {
    op: 'commit',
    segments: [{ coeffs: ['-1', '2'], a: '0', b: '1' }],
    params: { k: 0, slot: '1', segmentTolerance: '1', totalTolerance: '1' },
  };
  const { exitCode, out } = run({ ops: [bad] });
  assert.equal(exitCode, 1);
  assert.equal(out.results[0].error.code, 'E_NEGATIVE_VELOCITY');
});

test('undo/redo through the CLI restores certificates', () => {
  const commitB = {
    op: 'commit',
    segments: [{ coeffs: ['2'], a: '0', b: '1' }],
    params: { k: 0, slot: '1', segmentTolerance: '1', totalTolerance: '1' },
  };
  const { exitCode, out } = run({ ops: [COMMIT, commitB, { op: 'undo' }, { op: 'redo' }] });
  assert.equal(exitCode, 0);
  const [, certBResult, undoResult, redoResult] = out.results;
  assert.deepEqual(undoResult.certificate, out.results[0].certificate);
  assert.deepEqual(redoResult.certificate, certBResult.certificate);
});

test('failed commit does not disturb undo history', () => {
  const bad = {
    op: 'commit',
    segments: [{ coeffs: ['1'], a: '0', b: '1' }],
    params: { k: 0, slot: '-1', segmentTolerance: '1', totalTolerance: '1' },
  };
  const { exitCode, out } = run({ ops: [COMMIT, bad, { op: 'certificate' }] });
  assert.equal(exitCode, 1);
  assert.equal(out.results[1].error.code, 'E_INVALID_QUANTIZATION');
  assert.deepEqual(out.results[2].certificate, out.results[0].certificate);
});

test('invalid JSON input yields E_INVALID_INPUT and exit code 1', () => {
  const { exitCode, out } = run('not json{');
  assert.equal(exitCode, 1);
  assert.equal(out.ok, false);
  assert.equal(out.error.code, 'E_INVALID_INPUT');
});

test('unknown op yields E_INVALID_INPUT', () => {
  const { exitCode, out } = run({ ops: [{ op: 'bogus' }] });
  assert.equal(exitCode, 1);
  assert.equal(out.results[0].error.code, 'E_INVALID_INPUT');
});
