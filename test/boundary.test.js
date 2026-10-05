import test from 'node:test';
import assert from 'node:assert/strict';
import { replay } from '../src/replay.js';
import { budgetSet, cut, writeLog, runCli } from '../support/helpers.js';

// Acceptance 1: budget boundary +/-1 is deterministic.
// limit-1 -> cutting (ok), limit -> worn (ok), limit+1 -> locked (exit 12).

test('segment budget boundary -1/0/+1', () => {
  const base = budgetSet({ segment: 100 });

  const under = replay([...base, cut('c1', 99)]);
  assert.equal(under.tools.T1.status, 'cutting');
  assert.equal(under.exitCode, 0);
  assert.equal(under.overspend, null);

  const exact = replay([...base, cut('c1', 100)]);
  assert.equal(exact.tools.T1.status, 'worn');
  assert.equal(exact.exitCode, 0);
  assert.equal(exact.overspend, null);

  const over = replay([...base, cut('c1', 101)]);
  assert.equal(over.tools.T1.status, 'locked');
  assert.equal(over.exitCode, 12);
  assert.deepEqual(over.overspend.layers, [{ layer: 'segment', key: 'O1/P1/S1', usage: 101, limit: 100 }]);
});

test('boundary at every layer (order/operation/segment)', () => {
  for (const [level, key] of [['order', 'O1'], ['operation', 'O1/P1'], ['segment', 'O1/P1/S1']]) {
    const budgets = budgetSet({ order: 100, operation: 100, segment: 100 });
    const at = replay([...budgets, cut('c1', 100)]);
    assert.equal(at.exitCode, 0, `${level} at limit must not lock`);
    const over = replay([...budgets, cut('c1', 101)]);
    assert.equal(over.exitCode, 12, `${level} over limit must lock`);
    assert.ok(over.overspend.layers.some((l) => l.layer === level && l.key === key));
  }
});

test('crossing the boundary with a second cut reports the earliest overspend point', () => {
  const log = [...budgetSet({ segment: 100 }), cut('c1', 60), cut('c2', 41, ['c1'])];
  const r = replay(log);
  assert.equal(r.exitCode, 12);
  assert.equal(r.overspend.event, 'c2');
  assert.equal(r.overspend.layers[0].usage, 101);
});

test('boundary results are deterministic across repeated runs', () => {
  const file = writeLog([...budgetSet({ segment: 100 }), cut('c1', 101)]);
  const a = runCli(['replay', file]);
  const b = runCli(['replay', file]);
  assert.equal(a.code, 12);
  assert.equal(b.code, 12);
  assert.equal(a.stdout, b.stdout);
});
