'use strict';

// Acceptance 3: risk corrections re-order the plan while signed conclusions
// stay untouched; appeals freeze (not delete) conclusions and close by
// hierarchy (confirm vs roll back). Concurrent events order by
// (logical time, source, case ID).

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/core');

test('risk correction re-orders unstarted assignments', () => {
  const state = core.createState({ deptQuota: 1 });
  const meta = { time: 0, source: 't' };
  core.addReviewer(state, meta, { id: 'R1', skills: ['mol'] });
  core.addReviewer(state, meta, { id: 'R2', skills: ['mol'] });
  core.openCase(state, meta, { id: 'X', dept: 'd1', risk: 50, deadline: 10, duration: 2, skill: 'mol' });
  core.openCase(state, meta, { id: 'Y', dept: 'd1', risk: 60, deadline: 10, duration: 2, skill: 'mol' });

  core.runAssign(state, meta);
  assert.equal(state.cases.Y.assignment.reviewer, 'R1'); // higher risk first
  assert.equal(state.cases.X.assignment.reviewer, 'R2');

  core.correctRisk(state, meta, { id: 'X', risk: 70 });
  core.correctRisk(state, meta, { id: 'Y', risk: 40 });
  core.runAssign(state, meta);
  assert.equal(state.cases.X.assignment.reviewer, 'R1', 'corrected risk re-orders the plan');
  assert.equal(state.cases.Y.assignment.reviewer, 'R2');
});

test('high-risk preempts low-risk not-yet-started task and grants credit', () => {
  const state = core.createState({ deptQuota: 1 });
  const meta = { time: 0, source: 't' };
  core.addReviewer(state, meta, { id: 'R1', skills: ['mol'], unavailable: [[1, 10]] });
  core.openCase(state, meta, { id: 'LOW', dept: 'd1', risk: 30, deadline: 10, duration: 1, skill: 'mol' });
  core.runAssign(state, meta);
  assert.deepEqual(state.cases.LOW.assignment, { reviewer: 'R1', start: 0, end: 1 });

  core.openCase(state, meta, { id: 'HIGH', dept: 'd1', risk: 95, deadline: 5, duration: 1, skill: 'mol' });
  const run = core.runAssign(state, meta);
  assert.deepEqual(state.cases.HIGH.assignment, { reviewer: 'R1', start: 0, end: 1 });
  assert.equal(state.cases.LOW.status, 'preempted');
  assert.equal(state.cases.LOW.assignment, null);
  assert.equal(state.cases.LOW.credits, state.config.preemptCredit);
  assert.deepEqual(run.preemptions, [
    { caseId: 'LOW', credit: state.config.preemptCredit, reason: 'displaced_by_higher_risk' },
  ]);
});

test('signed conclusions immutable; appeals freeze then confirm or roll back', () => {
  const state = core.createState({ deptQuota: 1 });
  const meta = { time: 0, source: 't' };
  core.addReviewer(state, meta, { id: 'R1', skills: ['mol'] });
  core.openCase(state, meta, { id: 'Z', dept: 'd1', risk: 60, deadline: 10, duration: 2, skill: 'mol' });
  core.openCase(state, meta, { id: 'W', dept: 'd1', risk: 50, deadline: 10, duration: 1, skill: 'mol' });
  core.runAssign(state, meta);

  const { conclusion } = core.closeCase(state, { time: 2, source: 't' }, { id: 'Z' });
  const signedHash = conclusion.hash;

  // Corrections and re-planning must not touch the signed conclusion.
  core.correctRisk(state, { time: 2, source: 't' }, { id: 'W', risk: 99 });
  core.runAssign(state, { time: 2, source: 't' });
  assert.equal(state.cases.Z.conclusion.hash, signedHash);
  assert.equal(state.cases.Z.status, 'concluded');
  assert.throws(
    () => core.correctRisk(state, { time: 2, source: 't' }, { id: 'Z', risk: 10 }),
    (e) => e.code === 'CASE_CLOSED'
  );

  // Appeal freezes the conclusion instead of deleting it.
  core.openAppeal(state, { time: 3, source: 't' }, { id: 'Z', level: 2 });
  assert.equal(state.cases.Z.status, 'appeal_open');
  assert.equal(state.cases.Z.conclusion.frozen, true);
  assert.equal(state.cases.Z.conclusion.hash, signedHash);
  assert.throws(
    () => core.openAppeal(state, { time: 3, source: 't' }, { id: 'Z', level: 2 }),
    (e) => e.code === 'DUPLICATE_APPEAL' && e.exitCode === 8
  );

  // Uphold: conclusion confirmed at the appeal's hierarchy level.
  const { appeal } = core.closeCase(state, { time: 4, source: 't' }, { id: 'Z', decision: 'uphold' });
  assert.equal(appeal.status, 'confirmed');
  assert.equal(state.cases.Z.status, 'concluded');
  assert.equal(state.cases.Z.conclusion.frozen, false);
  assert.equal(state.cases.Z.conclusion.hash, signedHash);

  // Second appeal, overturned: conclusion rolled back, case reopens.
  core.openAppeal(state, { time: 5, source: 't' }, { id: 'Z', level: 3 });
  core.closeCase(state, { time: 6, source: 't' }, { id: 'Z', decision: 'overturn' });
  assert.equal(state.cases.Z.status, 'open');
  assert.equal(state.cases.Z.conclusion, null);
  assert.equal(state.cases.Z.assignment, null);
  assert.equal(state.cases.Z.history[0].type, 'revoked_conclusion');
  assert.equal(state.cases.Z.history[0].conclusion.hash, signedHash);
});

test('concurrent events order by (logical time, source, case ID)', () => {
  const build = (order) => {
    const state = core.createState();
    core.addReviewer(state, { time: 0, source: 'ops' }, { id: 'R1', skills: ['mol'] });
    for (const [id, source] of order) {
      core.openCase(state, { time: 2, source }, { id, dept: 'd1', risk: 50, deadline: 9, duration: 1, skill: 'mol' });
    }
    return state.certificate;
  };
  const a = build([['C1', 'lab'], ['C2', 'er'], ['C3', 'lab']]);
  const b = build([['C3', 'lab'], ['C1', 'lab'], ['C2', 'er']]);
  assert.equal(a, b, 'certificate is independent of arrival order for equal timestamps');
});
