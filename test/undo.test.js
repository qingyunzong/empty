import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, buildCompensation } from '../src/analyze.js';
import { runCli, tmpFile } from '../testing/helpers.mjs';

const config = {
  tools: { T1: 1000 },
  orders: { O1: 1000 },
  operations: { 'O1/OP1': 500 },
  segments: { 'O1/OP1/S1': 200 },
};

const m1 = { id: 'm1', type: 'measure', tool: 'T1', order: 'O1', op: 'OP1', seg: 'S1', length: 80, deps: [] };
const m2 = { id: 'm2', type: 'measure', tool: 'T1', order: 'O1', op: 'OP1', seg: 'S1', length: 60, deps: ['m1'] };

const layerUsed = (outcome, kind) => outcome.layers.find((l) => l.kind === kind).used;

test('before undo all layers accumulate the false measurement', () => {
  const { outcome, error } = analyze([m1, m2], config);
  assert.equal(error, null);
  assert.equal(layerUsed(outcome, 'seg'), 140);
  assert.equal(layerUsed(outcome, 'op'), 140);
  assert.equal(layerUsed(outcome, 'order'), 140);
  assert.equal(outcome.tools.T1.used, 140);
});

test('undoing a false measurement rolls back every layer consistently', () => {
  const cmp = { id: 'cmp1', type: 'compensate', target: 'm2', deps: ['m2'] };
  const { outcome, error } = analyze([m1, m2, cmp], config);
  assert.equal(error, null);
  assert.deepEqual(outcome.compensations, [{ id: 'cmp1', target: 'm2', length: 60 }]);
  assert.equal(layerUsed(outcome, 'seg'), 80);
  assert.equal(layerUsed(outcome, 'op'), 80);
  assert.equal(layerUsed(outcome, 'order'), 80);
  assert.equal(outcome.tools.T1.used, 80);
  const seg = outcome.layers.find((l) => l.kind === 'seg');
  const op = outcome.layers.find((l) => l.kind === 'op');
  const order = outcome.layers.find((l) => l.kind === 'order');
  assert.equal(seg.used, op.used);
  assert.equal(op.used, order.used);
  assert.equal(seg.remaining, 200 - 80);
  assert.equal(op.remaining, 500 - 80);
  assert.equal(order.remaining, 1000 - 80);
});

test('undo restores tool state derived from remaining consumption', () => {
  const life = { tools: { T1: 140 } };
  const before = analyze([m1, m2], life);
  assert.equal(before.outcome.tools.T1.state, 'worn');
  const cmp = { id: 'cmp1', type: 'compensate', target: 'm2', deps: ['m2'] };
  const after = analyze([m1, m2, cmp], life);
  assert.equal(after.outcome.tools.T1.state, 'cutting');
  assert.equal(after.outcome.tools.T1.used, 80);
});

test('buildCompensation depends on the target and all leaves', () => {
  const cmp = buildCompensation([m1, m2], 'm2');
  assert.equal(cmp.type, 'compensate');
  assert.equal(cmp.target, 'm2');
  assert.ok(cmp.deps.includes('m2'));
  assert.deepEqual(analyze([m1, m2, cmp], config).outcome.compensations.length, 1);
});

test('cli undo emits compensation and rolled-back budgets', () => {
  const log = tmpFile('log.jsonl', `${JSON.stringify(m1)}\n${JSON.stringify(m2)}\n`);
  const cfg = tmpFile('config.json', JSON.stringify(config));
  const undo = runCli(['undo', log, '--target', 'm2', '--config', cfg]);
  assert.equal(undo.code, 0);
  const report = JSON.parse(undo.stdout);
  assert.equal(report.compensation.target, 'm2');
  assert.equal(report.layers.find((l) => l.kind === 'seg').used, 80);
  const budget = runCli(['budget', log, '--config', cfg]);
  assert.equal(JSON.parse(budget.stdout).layers.find((l) => l.kind === 'seg').used, 140);
});

test('cli undo --append makes the rollback persistent', () => {
  const log = tmpFile('log.jsonl', `${JSON.stringify(m1)}\n${JSON.stringify(m2)}\n`);
  const cfg = tmpFile('config.json', JSON.stringify(config));
  const undo = runCli(['undo', log, '--target', 'm2', '--config', cfg, '--append']);
  assert.equal(undo.code, 0);
  assert.equal(JSON.parse(undo.stdout).appended, true);
  const budget = runCli(['budget', log, '--config', cfg]);
  assert.equal(budget.code, 0);
  const layers = JSON.parse(budget.stdout).layers;
  assert.equal(layers.find((l) => l.kind === 'seg').used, 80);
  assert.equal(layers.find((l) => l.kind === 'op').used, 80);
  assert.equal(layers.find((l) => l.kind === 'order').used, 80);
});
