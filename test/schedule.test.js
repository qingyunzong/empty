'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { schedule, planExact, priorityOf } = require('../src/schedule');
const { bruteForceOptimal, coverage, lcg, randomInstance } = require('./helpers');

test('skill x slot: unskilled reviewers and unavailable intervals are respected', () => {
  const reviewers = [
    { id: 'R1', skills: ['echo'], unavailable: [{ start: 0, end: 3 }] },
    { id: 'R2', skills: ['ct'], unavailable: [] },
  ];
  const cases = [
    { id: 'A', dept: 'd1', risk: 9, deadline: 10, skill: 'echo', duration: 2, openedAt: 0 },
    { id: 'B', dept: 'd1', risk: 5, deadline: 10, skill: 'ct', duration: 2, openedAt: 0 },
  ];
  const res = schedule(cases, reviewers, 0, { deptShare: 1 });
  const a = res.assignments.find((x) => x.caseId === 'A');
  const b = res.assignments.find((x) => x.caseId === 'B');
  assert.equal(a.reviewerId, 'R1');
  assert.ok(a.start >= 3, 'echo case must wait for R1 unavailability to end');
  assert.equal(b.reviewerId, 'R2');
});

test('exact planner matches independent brute-force optimum on random small instances', () => {
  const rand = lcg(20261004);
  for (let iter = 0; iter < 40; iter++) {
    const n = 1 + Math.floor(rand() * 5);
    const { cases, reviewers } = randomInstance(rand, {
      n,
      reviewers: [{ skills: ['echo', 'ct'] }, { skills: ['echo'] }],
    });
    const config = { deptShare: 1, highRisk: 8 };
    const res = planExact(cases, reviewers, 0, config, []);
    const got = coverage(res.assignments, cases, config);
    const want = bruteForceOptimal(cases, reviewers, 0, config);
    assert.deepEqual(got, want, `instance ${iter}: ${JSON.stringify(cases)}`);
  }
});

test('exact planner respects department quota when multiple departments compete', () => {
  const reviewers = [
    { id: 'R1', skills: ['x'], unavailable: [] },
    { id: 'R2', skills: ['x'], unavailable: [] },
  ];
  const cases = [];
  for (let i = 0; i < 4; i++) {
    cases.push({ id: `A${i}`, dept: 'alpha', risk: 5, deadline: 20, skill: 'x', duration: 2, openedAt: 0 });
  }
  cases.push({ id: 'B0', dept: 'beta', risk: 5, deadline: 20, skill: 'x', duration: 2, openedAt: 0 });
  const res = planExact(cases, reviewers, 0, { deptShare: 0.5 }, []);
  const perDept = {};
  for (const a of res.assignments) {
    const dept = a.caseId.startsWith('A') ? 'alpha' : 'beta';
    perDept[dept] = (perDept[dept] || 0) + 1;
  }
  assert.ok(perDept.alpha <= 1, `alpha capped at 1, got ${perDept.alpha}`);
  assert.equal(perDept.beta, 1);
});

test('single-department workloads are not quota limited', () => {
  const reviewers = [{ id: 'R1', skills: ['x'], unavailable: [] }];
  const cases = [0, 1, 2].map((i) => ({
    id: `A${i}`,
    dept: 'alpha',
    risk: 5,
    deadline: 20,
    skill: 'x',
    duration: 2,
    openedAt: 0,
  }));
  const res = planExact(cases, reviewers, 0, { deptShare: 0.5 }, []);
  assert.equal(res.assignments.length, 3);
});

test('priority: risk dominates, compensation credit boosts, waiting cases age in', () => {
  const base = { id: 'x', dept: 'd', deadline: 50, skill: 'x', duration: 1, openedAt: 0 };
  const hi = { ...base, id: 'hi', risk: 9 };
  const lo = { ...base, id: 'lo', risk: 3 };
  assert.ok(priorityOf(hi, 0) > priorityOf(lo, 0));
  const credited = { ...lo, credit: 5 };
  assert.ok(priorityOf(credited, 0) > priorityOf(lo, 0));
  const aged = { ...lo, openedAt: 0 };
  assert.ok(priorityOf(aged, 10) > priorityOf(aged, 0), 'age increases priority');
});

test('greedy path (>9 cases) defers department over quota and aging picks the oldest', () => {
  const reviewers = [
    { id: 'R1', skills: ['x'], unavailable: [] },
    { id: 'R2', skills: ['x'], unavailable: [] },
  ];
  const cases = [];
  for (let i = 0; i < 10; i++) {
    cases.push({ id: `A${String(i).padStart(2, '0')}`, dept: 'alpha', risk: 5, deadline: 60, skill: 'x', duration: 2, openedAt: 0 });
  }
  cases.push({ id: 'B00', dept: 'beta', risk: 5, deadline: 60, skill: 'x', duration: 2, openedAt: 0 });
  cases.push({ id: 'B01', dept: 'beta', risk: 5, deadline: 60, skill: 'x', duration: 2, openedAt: 0 });
  const res = schedule(cases, reviewers, 0, { deptShare: 0.5 });
  assert.equal(res.method, 'greedy');
  const alpha = res.assignments.filter((a) => a.caseId.startsWith('A'));
  const beta = res.assignments.filter((a) => a.caseId.startsWith('B'));
  assert.equal(alpha.length, 1, 'alpha monopoly capped by quota');
  assert.equal(beta.length, 1, 'beta capped by quota too');
  assert.ok(res.rejections.some((r) => r.code === 'QUOTA_DEFERRED'));
});
