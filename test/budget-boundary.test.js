import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/analyze.js';
import { EXIT } from '../src/errors.js';

const config = { tools: { T1: 100 } };
const layerConfig = { segments: { 'O1/OP1/S1': 50 } };

const measure = (id, length, deps = []) => ({
  id, type: 'measure', tool: 'T1', order: 'O1', op: 'OP1', seg: 'S1', length, deps,
});

test('boundary -1: one below tool life stays cutting', () => {
  const { outcome, error } = analyze([measure('e1', 99)], config);
  assert.equal(error, null);
  assert.equal(outcome.tools.T1.state, 'cutting');
  assert.equal(outcome.tools.T1.used, 99);
});

test('boundary exact: exactly at tool life becomes worn, not locked', () => {
  const { outcome, error } = analyze([measure('e1', 100)], config);
  assert.equal(error, null);
  assert.equal(outcome.tools.T1.state, 'worn');
  assert.equal(outcome.tools.T1.used, 100);
});

test('boundary +1: one above tool life locks and reports earliest overspend point', () => {
  const { outcome, error } = analyze([measure('e1', 101)], config);
  assert.equal(error.code, EXIT.BUDGET);
  assert.equal(outcome.tools.T1.state, 'locked');
  assert.equal(outcome.overspendPoint, 'e1');
  assert.equal(outcome.locks[0].kind, 'tool');
});

test('layer boundary: segment exactly at budget is allowed', () => {
  const { outcome, error } = analyze([measure('e1', 50)], layerConfig);
  assert.equal(error, null);
  const seg = outcome.layers.find((l) => l.kind === 'seg');
  assert.equal(seg.used, 50);
  assert.equal(seg.remaining, 0);
});

test('layer boundary +1: segment one above budget locks', () => {
  const { outcome, error } = analyze([measure('e1', 51)], layerConfig);
  assert.equal(error.code, EXIT.BUDGET);
  assert.equal(outcome.locks[0].kind, 'seg');
  assert.equal(outcome.overspendPoint, 'e1');
});

test('cumulative boundary across dependent events is exact', () => {
  const ok = analyze([measure('e1', 60), measure('e2', 40, ['e1'])], config);
  assert.equal(ok.error, null);
  assert.equal(ok.outcome.tools.T1.state, 'worn');
  const over = analyze([measure('e1', 60), measure('e2', 41, ['e1'])], config);
  assert.equal(over.error.code, EXIT.BUDGET);
  assert.equal(over.outcome.overspendPoint, 'e2');
});

test('replay is deterministic: identical logs give identical outcomes', () => {
  const log = [measure('e1', 30), measure('e2', 70, ['e1']), measure('e3', 1, ['e2'])];
  const first = analyze(log, config);
  const second = analyze(log, config);
  assert.deepEqual(first, second);
  assert.equal(first.error.code, EXIT.BUDGET);
  assert.equal(first.outcome.overspendPoint, 'e3');
});
