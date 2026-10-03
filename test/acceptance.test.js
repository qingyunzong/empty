'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { schedule, planExact } = require('../src/schedule');
const engine = require('../src/engine');
const store = require('../src/store');
const { bruteForceOptimal, coverage, lcg, randomInstance } = require('./helpers');
const { run: cli } = require('../bin/cli.js');

test('acceptance 1: n<=9 exact schedule matches enumerated max on-time high-risk coverage', () => {
  const rand = lcg(987654321);
  for (let iter = 0; iter < 30; iter++) {
    const n = 1 + Math.floor(rand() * 5);
    const { cases, reviewers } = randomInstance(rand, {
      n,
      reviewers: [{ skills: ['echo', 'ct'] }, { skills: ['ct'] }],
    });
    const config = { deptShare: 1, highRisk: 8 };
    const res = schedule(cases, reviewers, 0, config, []);
    assert.equal(res.method, 'exact');
    const got = coverage(res.assignments, cases, config);
    const want = bruteForceOptimal(cases, reviewers, 0, config);
    assert.deepEqual(got, want, `coverage must match enumeration: ${JSON.stringify(cases)}`);
  }
  const reviewers = [{ id: 'R1', skills: ['echo'], unavailable: [] }];
  const cases = [];
  for (let i = 0; i < 9; i++) {
    cases.push({ id: `H${i}`, dept: 'd', risk: 9, deadline: 12, skill: 'echo', duration: 2, openedAt: 0 });
  }
  const res = planExact(cases, reviewers, 0, { deptShare: 1 }, []);
  assert.equal(coverage(res.assignments, cases).high, 6);
});

test('acceptance 2: department monopoly is quota-limited and waiting cases age', () => {
  const reviewers = [
    { id: 'R1', skills: ['x'], unavailable: [] },
    { id: 'R2', skills: ['x'], unavailable: [] },
  ];
  const state = engine.createState();
  const open = (id, dept, time) =>
    engine.applyEvent(
      state,
      engine.openCase(state, reviewers, { caseId: id, dept, risk: 5, deadline: 80, skill: 'x', duration: 2, time })
    );
  for (let i = 0; i < 9; i++) open(`A${i}`, 'alpha', 0);
  open('A9', 'alpha', 1);
  open('B0', 'beta', 0);
  open('B1', 'beta', 0);
  const cfg = { deptShare: 0.5 };
  const round1 = engine.planAssignments(state, reviewers, cfg, { time: 2 });
  engine.applyEvent(state, round1.event);
  const r1alpha = round1.certificate.assignments.filter((a) => a.caseId.startsWith('A'));
  const r1beta = round1.certificate.assignments.filter((a) => a.caseId.startsWith('B'));
  assert.equal(r1alpha.length, 1, 'alpha monopoly limited by department quota');
  assert.equal(r1beta.length, 1);
  assert.ok(round1.certificate.rejections.some((r) => r.code === 'QUOTA_DEFERRED'));
  const round2 = engine.planAssignments(state, reviewers, cfg, { time: 4 });
  engine.applyEvent(state, round2.event);
  const r2cases = round2.certificate.assignments.map((a) => a.caseId);
  assert.ok(r2cases.includes('A1'), 'oldest waiting alpha case ages in first');
  assert.ok(!r2cases.includes('A9'), 'younger alpha case waits behind older ones');
  assert.ok(r2cases.includes('B1'));
});

test('acceptance 3: risk correction reorders the queue, signed conclusions unchanged', () => {
  const reviewers = [{ id: 'R1', skills: ['echo'], unavailable: [] }];
  const state = engine.createState();
  const open = (id, risk) =>
    engine.applyEvent(
      state,
      engine.openCase(state, reviewers, { caseId: id, dept: 'd', risk, deadline: 40, skill: 'echo', duration: 2, time: 0 })
    );
  open('S1', 4);
  open('S2', 6);
  open('S3', 5);
  const plan1 = engine.planAssignments(state, reviewers, {}, { time: 0 });
  engine.applyEvent(state, plan1.event);
  const starts1 = Object.fromEntries(plan1.certificate.assignments.map((a) => [a.caseId, a.start]));
  assert.ok(starts1.S2 < starts1.S3 && starts1.S3 < starts1.S1);
  engine.applyEvent(state, engine.correctRisk(state, { caseId: 'S1', risk: 9, time: 1 }));
  const plan2 = engine.planAssignments(state, reviewers, {}, { time: 1 });
  engine.applyEvent(state, plan2.event);
  const starts2 = Object.fromEntries(plan2.certificate.assignments.map((a) => [a.caseId, a.start]));
  assert.ok(starts2.S1 < starts2.S3, 'corrected high risk jumps the queue');
  engine.applyEvent(state, engine.closeCase(state, { caseId: 'S2', result: 'signed-off', level: 1, time: 3 }));
  assert.throws(() => engine.correctRisk(state, { caseId: 'S2', risk: 1, time: 4 }), /immutable/);
  assert.equal(state.cases.S2.conclusion.result, 'signed-off');
  assert.equal(state.cases.S2.conclusion.status, 'signed');
});

test('acceptance 4: snapshot crash recovery leaves the certificate recomputable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-acc4-'));
  fs.writeFileSync(
    path.join(dir, 'reviewers.json'),
    JSON.stringify({ reviewers: [{ id: 'R1', skills: ['echo'], unavailable: [] }] })
  );
  const run = (...args) =>
    JSON.parse(cli(['--state', dir, ...args]).stdout);
  run('open', '--case', 'C1', '--dept', 'cardio', '--risk', '9', '--deadline', '30', '--skill', 'echo', '--duration', '2', '--time', '0');
  run('open', '--case', 'C2', '--dept', 'neuro', '--risk', '4', '--deadline', '30', '--skill', 'echo', '--duration', '2', '--time', '0');
  const cert1 = run('assign', '--time', '0');
  run('snapshot', '--time', '1');
  run('correct', '--case', 'C2', '--risk', '8', '--time', '2');
  const cert2 = run('assign', '--time', '3');
  fs.appendFileSync(path.join(dir, 'events.jsonl'), '{"type":"OPE');
  const recovered = store.recover(dir).state;
  const recomputed = store.recompute(dir);
  assert.equal(recovered.certHash, recomputed.certHash, 'certificate hash recomputable after crash');
  assert.deepEqual(
    recovered.certificates.map((c) => c.hash),
    [cert1.hash, cert2.hash]
  );
  const verify = run('verify');
  assert.equal(verify.match, true);
});
