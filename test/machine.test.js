import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/analyze.js';
import { EXIT, ReplayError } from '../src/errors.js';

const measure = (id, length, deps = []) => ({
  id, type: 'measure', tool: 'T1', order: 'O1', op: 'OP1', seg: 'S1', length, deps,
});

test('causal guard rejects unknown dependency with exit 13', () => {
  assert.throws(
    () => analyze([measure('e1', 10, ['ghost'])]),
    (err) => err instanceof ReplayError && err.code === EXIT.TRANSITION,
  );
});

test('causal guard rejects dependency cycles with exit 13', () => {
  const log = [measure('e1', 10, ['e2']), measure('e2', 10, ['e1'])];
  assert.throws(
    () => analyze(log),
    (err) => err instanceof ReplayError && err.code === EXIT.TRANSITION,
  );
});

test('compensation must causally depend on its target', () => {
  const log = [measure('m1', 10), { id: 'cmp1', type: 'compensate', target: 'm1', deps: [] }];
  const { error } = analyze(log, {});
  assert.equal(error.code, EXIT.TRANSITION);
});

test('double compensation of the same target is illegal', () => {
  const log = [
    measure('m1', 10),
    { id: 'cmp1', type: 'compensate', target: 'm1', deps: ['m1'] },
    { id: 'cmp2', type: 'compensate', target: 'm1', deps: ['cmp1'] },
  ];
  const { outcome } = analyze(log, {});
  assert.ok(outcome.errors.some((e) => e.code === EXIT.TRANSITION && e.message.includes('already compensated')));
});

test('compensating a non-measurement is illegal', () => {
  const log = [
    { id: 'c1', type: 'cut', tool: 'T1', order: 'O1', op: 'OP1', seg: 'S1', length: 10, deps: [] },
    { id: 'cmp1', type: 'compensate', target: 'c1', deps: ['c1'] },
  ];
  const { error } = analyze(log, {});
  assert.equal(error.code, EXIT.TRANSITION);
});

test('consumption on a locked tool is an illegal transition', () => {
  const log = [
    measure('m1', 60),
    measure('m2', 10, ['m1']),
  ];
  const { outcome, error } = analyze(log, { tools: { T1: 50 } });
  assert.equal(error.code, EXIT.BUDGET);
  assert.ok(outcome.errors.some((e) => e.code === EXIT.TRANSITION && e.details.event === 'm2'));
});

test('tool_change resets a non-locked tool to idle', () => {
  const log = [
    measure('m1', 30),
    { id: 'tc1', type: 'tool_change', tool: 'T1', deps: ['m1'] },
    measure('m2', 40, ['tc1']),
  ];
  const { outcome, error } = analyze(log, { tools: { T1: 50 } });
  assert.equal(error, null);
  assert.equal(outcome.tools.T1.state, 'cutting');
  assert.equal(outcome.tools.T1.used, 40);
});
