'use strict';

// The sandbox forbids spawning child processes from tests, so the CLI is
// exercised through src/cli-core.js (the exact code path cli.js wires to
// stdin/stdout). cli.js itself is verified manually via shell piping.

const test = require('node:test');
const assert = require('node:assert/strict');
const { runCli } = require('../src/cli-core');

const SCRIPT = {
  ops: [
    { op: 'addPlate', plate: 'P1' },
    { op: 'addWell', plate: 'P1', well: 'A1', absorbance: 0.1 },
    { op: 'addWell', plate: 'P1', well: 'A2', absorbance: 0.5 },
    { op: 'addWell', plate: 'P1', well: 'A3', absorbance: 1.0 },
    { op: 'setControl', plate: 'P1', kind: 'neg', well: 'A1' },
    { op: 'setControl', plate: 'P1', kind: 'pos', well: 'A3' },
    { op: 'addReplicate', group: 'G1', wells: ['P1/A2', 'P1/A3'] },
    { op: 'addReplicate', group: 'G2', wells: [] },
    { op: 'moveWell', from: 'G1', to: 'G2', well: 'P1/A3' },
    { op: 'undo' },
    { op: 'snapshot' },
  ],
};

test('CLI processes an op script from stdin', () => {
  const { status, output } = runCli(JSON.stringify(SCRIPT));
  assert.equal(status, 0);
  assert.equal(output.results.length, SCRIPT.ops.length);
  // every mutation reports a diff and a certificate
  const move = output.results[8];
  assert.deepEqual(move.certificate.invalidated, [
    'repMean:G1', 'repMean:G2', 'repCV:G1', 'repCV:G2',
  ]);
  assert.ok(move.diff.length > 0);
  assert.equal(typeof move.certificate.hash, 'string');
  // undo result also carries diff + certificate
  const undo = output.results[9];
  assert.deepEqual(undo.op.of, { op: 'moveWell', from: 'G1', to: 'G2', well: 'P1/A3' });
  // snapshot reflects the undone state: G2 empty -> E_QC
  const snap = output.results[10].state;
  assert.equal(snap.nodes['repMean:G2'].error, 'E_QC');
  assert.equal(snap.nodes['corr:P1:A2'].value, 0.4);
  assert.equal(output.final.hash, snap.hash);
});

test('CLI accepts a bare op array', () => {
  const { status, output } = runCli(JSON.stringify(SCRIPT.ops.slice(0, 2)));
  assert.equal(status, 0);
  assert.equal(output.results.length, 2);
});

test('CLI reports op errors without aborting the script', () => {
  const { status, output } = runCli(JSON.stringify({
    ops: [
      { op: 'addPlate', plate: 'P1' },
      { op: 'addWell', plate: 'NOPE', well: 'A1', absorbance: 1 },
      { op: 'bogus' },
      { op: 'snapshot' },
    ],
  }));
  assert.equal(status, 0);
  assert.equal(output.results[1].error, 'E_OP');
  assert.equal(output.results[2].error, 'E_OP');
  assert.equal(output.results[3].state.nodes['plateMean:P1'].error, 'E_QC');
});

test('CLI rejects invalid JSON on stdin', () => {
  const { status, output } = runCli('not json{');
  assert.equal(status, 1);
  assert.equal(output.error, 'E_INPUT');
});

test('CLI rejects a payload without an ops array', () => {
  const { status, output } = runCli('{"nope": 1}');
  assert.equal(status, 1);
  assert.equal(output.error, 'E_INPUT');
});
