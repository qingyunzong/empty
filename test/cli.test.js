'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execute } = require('../cli');

// Drives the exact stdin -> stdout contract of cli.js in-process
// (the sandbox forbids spawning child processes from within node).
function runCli(request) {
  const { line, exitCode } = execute(JSON.stringify(request));
  assert.equal(typeof line, 'string');
  assert.ok(!line.includes('\n'), 'stdout must be a single JSON line');
  return { exitCode, output: JSON.parse(line) };
}

test('CLI: full edit/undo/certificate session over stdin JSON', () => {
  const { exitCode, output } = runCli({
    commands: [
      { op: 'init', quantumExp: 2, slot: '1/2', segmentTolerance: '1/10', totalTolerance: '1/2' },
      { op: 'edit', segments: [{ coeffs: ['1', '1/2'], a: '0', b: '1' }] },
      { op: 'edit', segments: [{ coeffs: ['2'], a: '1', b: '2' }] },
      { op: 'certificate' },
      { op: 'undo' },
      { op: 'certificate' },
      { op: 'redo' },
      { op: 'certificate' },
    ],
  });
  assert.equal(exitCode, 0);
  assert.equal(output.ok, true);
  const [, edit1, edit2, cert1, undo, cert2, redo, cert3] = output.results;
  assert.equal(edit1.ok, true);
  assert.equal(edit2.ok, true);
  assert.equal(cert1.certificate.segmentCount, 2);
  assert.equal(undo.ok, true);
  assert.equal(cert2.certificate.segmentCount, 1, 'undo restores earlier certificate');
  assert.deepEqual(cert2.certificate, edit1.certificate);
  assert.equal(redo.ok, true);
  assert.deepEqual(cert3.certificate, cert1.certificate);
});

test('CLI: tolerance failure returns E_TOLERANCE and generates no trajectory', () => {
  const { exitCode, output } = runCli({
    commands: [
      { op: 'init', quantumExp: 1, slot: '1', segmentTolerance: '1/21', totalTolerance: '1/20' },
      { op: 'edit', segments: [{ coeffs: ['3/20'], a: '0', b: '1' }] },
      { op: 'certificate' },
    ],
  });
  assert.equal(exitCode, 0);
  assert.equal(output.ok, false);
  assert.equal(output.results[1].ok, false);
  assert.equal(output.results[1].code, 'E_TOLERANCE');
  assert.equal(output.results[2].certificate.segmentCount, 0, 'no trajectory on failure');
});

test('CLI: negative velocity edit rolls back', () => {
  const { exitCode, output } = runCli({
    commands: [
      { op: 'init', quantumExp: 1, slot: '1/2', segmentTolerance: '1', totalTolerance: '10' },
      { op: 'edit', segments: [{ coeffs: ['1'], a: '0', b: '1' }] },
      { op: 'edit', segments: [{ coeffs: ['5/2', '-1'], a: '2', b: '3' }] },
      { op: 'certificate' },
    ],
  });
  assert.equal(exitCode, 0);
  assert.equal(output.results[1].ok, true);
  assert.equal(output.results[2].ok, false);
  assert.equal(output.results[2].code, 'E_NEGATIVE_VELOCITY');
  assert.equal(output.results[3].certificate.segmentCount, 1);
});

test('CLI: error exactly equal to tolerance passes', () => {
  const { exitCode, output } = runCli({
    commands: [
      { op: 'init', quantumExp: 1, slot: '1', segmentTolerance: '1/20', totalTolerance: '1/20' },
      { op: 'edit', segments: [{ coeffs: ['3/20'], a: '0', b: '1' }] },
    ],
  });
  assert.equal(exitCode, 0);
  assert.equal(output.ok, true);
  const seg = output.results[1].certificate.segments[0];
  assert.equal(seg.absError, '1/20');
  assert.equal(seg.exactIntegral, '3/20');
  assert.equal(seg.quantized, '1/5');
});

test('CLI: invalid JSON input exits non-zero with E_PARSE', () => {
  const { line, exitCode } = execute('not json');
  assert.equal(exitCode, 1);
  const output = JSON.parse(line);
  assert.equal(output.ok, false);
  assert.equal(output.code, 'E_PARSE');
});

test('CLI: explicit transaction ops (beginEdit/addSegment/commit/rollback)', () => {
  const { exitCode, output } = runCli({
    commands: [
      { op: 'init', quantumExp: 1, slot: '1/2', segmentTolerance: '1', totalTolerance: '10' },
      { op: 'beginEdit' },
      { op: 'addSegment', coeffs: ['1'], a: '0', b: '1' },
      { op: 'addSegment', coeffs: ['2'], a: '1', b: '2' },
      { op: 'commit' },
      { op: 'beginEdit' },
      { op: 'addSegment', coeffs: ['3'], a: '2', b: '3' },
      { op: 'rollback' },
      { op: 'certificate' },
    ],
  });
  assert.equal(exitCode, 0);
  assert.equal(output.results[4].ok, true);
  assert.equal(output.results[8].certificate.segmentCount, 2, 'rolled-back edit leaves no trace');
});
