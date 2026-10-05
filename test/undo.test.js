import test from 'node:test';
import assert from 'node:assert/strict';
import { replay } from '../src/replay.js';
import { planUndo } from '../src/undo.js';
import { budgetSet, cut, measure, writeLog, runCli } from '../support/helpers.js';

// Acceptance 2: undoing a false measurement rolls back layered budgets consistently.
// Acceptance 4: after locked, no recovery can unmark produced scrap.

test('undo of false measure rolls back every layer consistently (no lock)', () => {
  const log = [
    ...budgetSet({ order: 1000, operation: 500, segment: 100 }),
    cut('c1', 40),
    measure('m1', 30, ['c1']),
  ];
  const before = replay(log);
  assert.equal(before.budgets.segment['O1/P1/S1'].usage, 70);

  const plan = planUndo(log, 'm1');
  for (const r of plan.rollback) {
    assert.equal(r.before - r.after, 30, `${r.layer} must roll back by the measure length`);
  }
  assert.deepEqual(plan.rollback.map((r) => r.after), [40, 40, 40]);
  assert.equal(plan.lockedFacts.length, 0);
  assert.equal(plan.status, 'cutting');
  assert.ok(plan.recoveryPath.some((s) => s.step === 'resume'));
});

test('undo after lock: budgets roll back but locked fact and scrap stay marked', () => {
  const log = [
    ...budgetSet({ order: 1000, operation: 500, segment: 100 }),
    cut('c1', 60),
    measure('m1', 50, ['c1']), // false measurement pushes usage to 110 > 100 -> locked
    cut('c2', 10, ['m1']),      // cut on locked tool -> scrap
  ];
  const before = replay(log);
  assert.equal(before.exitCode, 12);
  assert.equal(before.overspend.event, 'm1');
  assert.deepEqual(before.tools.T1.scrap, ['c2']);

  const plan = planUndo(log, 'm1');
  // layered rollback is consistent: 120 -> 70 at every layer
  assert.deepEqual(plan.rollback.map((r) => [r.before, r.after]), [[120, 70], [120, 70], [120, 70]]);
  // locked fact retained, scrap not unmarked
  assert.deepEqual(plan.lockedFacts, [before.tools.T1.lockFact]);
  assert.deepEqual(plan.scrap, ['c2']);
  const verdict = plan.recoveryPath.find((s) => s.step === 'scrap_verdict');
  assert.equal(verdict.reversible, false);
  assert.deepEqual(verdict.cuts, ['c2']);
  assert.ok(plan.recoveryPath.some((s) => s.step === 'locked_fact_retained'));
  assert.ok(plan.recoveryPath.some((s) => s.step === 'replace_tool'));
  assert.ok(!plan.recoveryPath.some((s) => s.step === 'resume'));
});

test('in-log compensate event also keeps locked facts and scrap immutable', () => {
  const log = [
    ...budgetSet({ segment: 100 }),
    cut('c1', 60),
    measure('m1', 50, ['c1']),
    cut('c2', 10, ['m1']),
    { type: 'compensate', id: 'x1', tool: 'T1', target: 'm1', causes: ['c2'] },
  ];
  const r = replay(log);
  assert.equal(r.tools.T1.status, 'locked');
  assert.deepEqual(r.tools.T1.scrap, ['c2']);
  assert.equal(r.budgets.segment['O1/P1/S1'].usage, 70);
  assert.equal(r.exitCode, 12); // earliest overspend fact preserved
  assert.equal(r.overspend.event, 'm1');
});

test('undo rejects non-measure targets and unknown ids', () => {
  const log = [...budgetSet({ segment: 100 }), cut('c1', 10)];
  const r1 = runCli(['undo', writeLog(log), 'c1']);
  assert.equal(r1.code, 2);
  const r2 = runCli(['undo', writeLog(log), 'nope']);
  assert.equal(r2.code, 2);
});

test('undo via CLI prints recovery path and exits 0 even when log is over budget', () => {
  const log = [
    ...budgetSet({ segment: 100 }),
    cut('c1', 60),
    measure('m1', 50, ['c1']),
    cut('c2', 10, ['m1']),
  ];
  const r = runCli(['undo', writeLog(log), 'm1']);
  assert.equal(r.code, 0);
  const plan = r.json();
  assert.equal(plan.compensation.target, 'm1');
  assert.deepEqual(plan.scrap, ['c2']);
});
