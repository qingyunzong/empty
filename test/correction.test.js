import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHistory } from '../src/history.js';
import { runCheck } from '../src/api.js';
import { buildOutput, verifyOutput } from '../src/certificate.js';
import { compile, REGISTER_DSL } from '../testkit/helpers.js';

const HISTORY = [
  { id: 'e1', node: 'n1', prev: null, invocation: 1, response: 2, realTime: 1, op: 'write', key: 'x', value: 2 },
  { id: 'e2', node: 'n2', prev: null, invocation: 3, response: 4, realTime: 3, op: 'read', key: 'x', value: 1 },
  { id: 'c1', corrects: 'e2', realTime: 10, op: 'read', key: 'x', value: 2 },
];

test('acceptance 4: a correction changes the verdict and supersedes the old certificate', () => {
  const compiled = compile(REGISTER_DSL);
  const text = HISTORY.map((h) => JSON.stringify(h)).join('\n');
  const results = runCheck(compiled, parseHistory(text));
  assert.equal(results.length, 2);
  assert.equal(results[0].verdict, 'NON_LINEARIZABLE');
  assert.equal(results[1].verdict, 'LINEARIZABLE');

  const out = buildOutput(compiled, results);
  assert.equal(out.verdict, 'LINEARIZABLE');
  assert.equal(out.versions[0].status, 'SUPERSEDED');
  assert.equal(out.versions[0].verdict, 'NON_LINEARIZABLE');
  assert.equal(out.versions[1].status, 'CURRENT');
  assert.equal(out.versions[1].correction.id, 'c1');
  assert.equal(verifyOutput(out).ok, true);
});

test('corrections apply in realTime order, producing one version each', () => {
  const compiled = compile(REGISTER_DSL);
  const lines = [
    { id: 'e1', node: 'n1', prev: null, invocation: 1, response: 2, realTime: 1, op: 'write', key: 'x', value: 9 },
    { id: 'e2', node: 'n2', prev: null, invocation: 3, response: 4, realTime: 3, op: 'read', key: 'x', value: 1 },
    { id: 'c2', corrects: 'e1', realTime: 12, op: 'write', key: 'x', value: 1 },
    { id: 'c1', corrects: 'e2', realTime: 10, op: 'read', key: 'x', value: 9 },
  ].map((h) => JSON.stringify(h)).join('\n');
  const results = runCheck(compiled, parseHistory(lines));
  assert.equal(results.length, 3);
  // v1: read 1 after write 9 -> NON_LINEARIZABLE
  assert.equal(results[0].verdict, 'NON_LINEARIZABLE');
  // v2: read corrected to 9 -> LINEARIZABLE
  assert.equal(results[1].verdict, 'LINEARIZABLE');
  // v3: write corrected to 1 but read says 9 -> NON_LINEARIZABLE
  assert.equal(results[2].verdict, 'NON_LINEARIZABLE');
});

test('correction of a missing event yields UNKNOWN, not a crash', () => {
  const compiled = compile(REGISTER_DSL);
  const lines = [
    { id: 'e1', node: 'n1', prev: null, invocation: 1, response: 2, realTime: 1, op: 'write', key: 'x', value: 1 },
    { id: 'c1', corrects: 'ghost', realTime: 5, op: 'write', key: 'x', value: 2 },
  ].map((h) => JSON.stringify(h)).join('\n');
  const results = runCheck(compiled, parseHistory(lines));
  assert.equal(results[0].verdict, 'LINEARIZABLE');
  assert.equal(results[1].verdict, 'UNKNOWN');
  const out = buildOutput(compiled, results);
  assert.equal(out.versions[1].certificate.reason, 'correction-target-missing');
  assert.equal(verifyOutput(out).ok, true);
});
