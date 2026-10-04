'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { solve, emptyState } = require('../src/solver');
const { bruteForce, randomState, mulberry32 } = require('./helpers');

function baseState() {
  const s = emptyState();
  s.molds = { M1: { life: 10000 }, M2: { life: 10000 } };
  s.setup = { M1: 10, M2: 10 };
  s.changeover = { M1: { M2: 5 }, M2: { M1: 5 } };
  return s;
}

test('budget boundary: exact capacity feasible, one minute less infeasible', () => {
  const s = baseState();
  s.shifts = { S1: { capacity: 210 } };
  s.jobs = {
    J1: { mold: 'M1', shots: 10, duration: 100 },
    J2: { mold: 'M1', shots: 10, duration: 100 }
  };
  const ok = solve(s);
  assert.equal(ok.feasible, true);
  assert.equal(ok.cost, 210); // setup 10 + 100 + 100, same mold so no changeover

  s.shifts.S1.capacity = 209;
  const no = solve(s);
  assert.equal(no.feasible, false);
});

test('budget boundary: mold life exactly at demand feasible, one shot less infeasible', () => {
  const s = baseState();
  s.shifts = { S1: { capacity: 1000 } };
  s.jobs = {
    J1: { mold: 'M1', shots: 60, duration: 10 },
    J2: { mold: 'M1', shots: 40, duration: 10 }
  };
  s.molds.M1.life = 100;
  assert.equal(solve(s).feasible, true);
  s.molds.M1.life = 99;
  const no = solve(s);
  assert.equal(no.feasible, false);
  assert.match(no.reason, /mold-life-exceeded:M1/);
});

test('tie-break: equal-cost optima resolve to the same canonical plan', () => {
  const build = (jobOrder) => {
    const s = emptyState();
    s.shifts = { S1: { capacity: 100 }, S2: { capacity: 100 } };
    s.molds = { M1: { life: 1000 }, M2: { life: 1000 } };
    s.setup = { M1: 5, M2: 5 };
    s.changeover = { M1: { M2: 7 }, M2: { M1: 7 } };
    s.jobs = {};
    for (const j of jobOrder) s.jobs[j.id] = j.data;
    return s;
  };
  const j1 = { id: 'J1', data: { mold: 'M1', shots: 10, duration: 10 } };
  const j2 = { id: 'J2', data: { mold: 'M2', shots: 10, duration: 10 } };
  const a = solve(build([j1, j2]));
  const b = solve(build([j2, j1]));
  const c = solve(build([j1, j2]));
  assert.equal(a.feasible, true);
  assert.equal(a.cost, 30); // split across shifts beats paying the changeover
  assert.equal(a.planStr, 'S1:J1|S2:J2|');
  assert.equal(b.planStr, a.planStr);
  assert.equal(c.planStr, a.planStr);
});

test('enumeration cross-check: solver matches brute force for n<=9', () => {
  for (let n = 1; n <= 9; n++) {
    for (let seed = 1; seed <= 8; seed++) {
      const rand = mulberry32(seed * 1000 + n);
      const state = randomState(rand, n);
      const got = solve(state);
      const want = bruteForce(state);
      assert.equal(got.feasible, want.feasible, `feasibility n=${n} seed=${seed}`);
      if (want.feasible) {
        assert.equal(got.cost, want.cost, `cost n=${n} seed=${seed}`);
        assert.equal(got.planStr, want.str, `plan n=${n} seed=${seed}`);
      }
    }
  }
});
