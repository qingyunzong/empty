'use strict';

// Acceptance 2: department monopoly is capped by quota and waiting cases age.

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/core');

function baseState(cfg = {}) {
  const state = core.createState(cfg);
  core.addReviewer(state, { time: 0, source: 't' }, { id: 'R1', skills: ['x'] });
  return state;
}

test('department quota breaks monopoly and waiting cases get scheduled', () => {
  const state = baseState({ deptQuota: 0.5 });
  const meta = { time: 0, source: 't' };
  for (let i = 1; i <= 4; i++) {
    core.openCase(state, meta, { id: `A${i}`, dept: 'patho', risk: 90, deadline: 30, duration: 1, skill: 'x' });
  }
  for (let i = 1; i <= 2; i++) {
    core.openCase(state, meta, { id: `B${i}`, dept: 'heme', risk: 50, deadline: 30, duration: 1, skill: 'x' });
  }

  const run0 = core.runAssign(state, { time: 0, source: 't' });
  const depts0 = run0.assignments.map((a) => state.cases[a.caseId].dept);
  const share0 = depts0.filter((d) => d === 'patho').length / depts0.length;
  assert.ok(share0 <= 0.5, `patho share ${share0} exceeds quota`);
  assert.ok(depts0.includes('heme'), 'lower-risk heme case scheduled despite patho flood');
  assert.equal(run0.rejections.A2, 'QUOTA_BLOCKED');
  assert.equal(run0.rejections.A3, 'QUOTA_BLOCKED');
  assert.equal(run0.rejections.A4, 'QUOTA_BLOCKED');

  for (let t = 1; t <= 6; t++) core.runAssign(state, { time: t, source: 't' });
  for (const id of ['A1', 'A2', 'A3', 'A4', 'B1', 'B2']) {
    assert.ok(state.cases[id].assignment, `${id} eventually scheduled`);
  }
});

test('waiting cases age: old low-risk outranks fresh higher-risk', () => {
  const state = core.createState({ agingRate: 5, deptQuota: 1 });
  core.addReviewer(state, { time: 0, source: 't' }, { id: 'R1', skills: ['x'], unavailable: [[0, 5]] });
  core.openCase(state, { time: 0, source: 't' }, { id: 'L', dept: 'd1', risk: 40, deadline: 40, duration: 1, skill: 'x' });
  const run0 = core.runAssign(state, { time: 0, source: 't' });
  assert.equal(run0.assignments[0].start, 5); // reviewer busy until t=5, L waits

  core.openCase(state, { time: 5, source: 't' }, { id: 'H', dept: 'd1', risk: 60, deadline: 40, duration: 1, skill: 'x' });
  const run5 = core.runAssign(state, { time: 5, source: 't' });
  // L effective risk = 40 + 5*5 = 65 > 60: the aged case goes first.
  assert.equal(run5.assignments[0].caseId, 'L');
  assert.equal(run5.assignments[0].start, 5);
  assert.equal(run5.assignments[1].caseId, 'H');
});
