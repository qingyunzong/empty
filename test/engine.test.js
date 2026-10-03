'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DomainError,
  createState,
  applyEvent,
  openCase,
  correctRisk,
  openAppeal,
  closeAppeal,
  closeCase,
  planAssignments,
} = require('../src/engine');

const REVIEWERS = [
  { id: 'R1', skills: ['echo'], unavailable: [] },
  { id: 'R2', skills: ['ct'], unavailable: [] },
];

function open(state, id, over = {}) {
  const ev = openCase(state, REVIEWERS, {
    caseId: id,
    dept: 'cardio',
    risk: 5,
    deadline: 30,
    skill: 'echo',
    duration: 2,
    time: 0,
    ...over,
  });
  return applyEvent(state, ev);
}

test('open rejects past statutory deadline and unknown skill', () => {
  const state = createState();
  assert.throws(
    () => openCase(state, REVIEWERS, { caseId: 'X', dept: 'd', risk: 1, deadline: 5, skill: 'echo', duration: 1, time: 5 }),
    (e) => e instanceof DomainError && e.code === 'DEADLINE_PAST'
  );
  assert.throws(
    () => openCase(state, REVIEWERS, { caseId: 'X', dept: 'd', risk: 1, deadline: 50, skill: 'mri', duration: 1, time: 0 }),
    (e) => e instanceof DomainError && e.code === 'SKILL_MISMATCH'
  );
});

test('risk correction reorders the plan; signed conclusions are immutable', () => {
  const state = createState();
  open(state, 'K1', { risk: 5 });
  open(state, 'K2', { risk: 6 });
  open(state, 'K3', { risk: 4 });
  const oneReviewer = [REVIEWERS[0]];
  const first = planAssignments(state, oneReviewer, {}, { time: 0 });
  applyEvent(state, first.event);
  const order1 = first.certificate.assignments
    .slice()
    .sort((a, b) => a.start - b.start)
    .map((a) => a.caseId);
  assert.deepEqual(order1, ['K2', 'K1', 'K3']);

  applyEvent(state, correctRisk(state, { caseId: 'K3', risk: 9, time: 1 }));
  const second = planAssignments(state, oneReviewer, {}, { time: 1 });
  applyEvent(state, second.event);
  const order2 = second.certificate.assignments
    .slice()
    .sort((a, b) => a.start - b.start)
    .map((a) => a.caseId);
  assert.deepEqual(order2, ['K3', 'K1'], 'corrected risk must reorder not-yet-started work');
  assert.deepEqual(state.assignments.K2, { reviewerId: 'R1', start: 0, end: 2 }, 'started task stays fixed');

  applyEvent(state, closeCase(state, { caseId: 'K2', result: 'approved', level: 2, time: 3 }));
  assert.throws(
    () => correctRisk(state, { caseId: 'K2', risk: 1, time: 4 }),
    (e) => e.code === 'CASE_CLOSED'
  );
  assert.equal(state.cases.K2.conclusion.status, 'signed');
  assert.equal(state.cases.K2.conclusion.result, 'approved');
});

test('appeal freezes (not deletes) the conclusion; close resolves by hierarchy', () => {
  const state = createState();
  open(state, 'P1');
  const plan = planAssignments(state, [REVIEWERS[0]], {}, { time: 0 });
  applyEvent(state, plan.event);
  applyEvent(state, closeCase(state, { caseId: 'P1', result: 'positive', level: 2, time: 3 }));

  applyEvent(state, openAppeal(state, { caseId: 'P1', level: 1, time: 4 }));
  assert.equal(state.cases.P1.conclusion.status, 'frozen', 'conclusion frozen, not deleted');
  assert.equal(state.cases.P1.conclusion.result, 'positive');

  assert.throws(
    () => openAppeal(state, { caseId: 'P1', level: 1, time: 5 }),
    (e) => e.code === 'DUPLICATE_APPEAL'
  );

  const lowClose = closeAppeal(state, { caseId: 'P1', time: 6 });
  assert.equal(lowClose.decision, 'confirmed', 'lower-level appeal cannot revoke');
  applyEvent(state, lowClose);
  assert.equal(state.cases.P1.conclusion.status, 'confirmed');

  applyEvent(state, openAppeal(state, { caseId: 'P1', level: 3, time: 7 }));
  const highClose = closeAppeal(state, { caseId: 'P1', time: 8 });
  assert.equal(highClose.decision, 'revoked', 'higher-level appeal rolls back');
  applyEvent(state, highClose);
  assert.equal(state.cases.P1.conclusion.status, 'revoked');
  assert.equal(state.cases.P1.status, 'waiting', 'revoked case re-enters the queue');
});

test('high-risk case preempts a not-yet-started low-risk task and grants compensation credit', () => {
  const reviewers = [{ id: 'R1', skills: ['echo'], unavailable: [{ start: 0, end: 3 }] }];
  const state = createState();
  const ev1 = openCase(state, reviewers, { caseId: 'LOW', dept: 'd', risk: 3, deadline: 10, skill: 'echo', duration: 4, time: 0 });
  applyEvent(state, ev1);
  const plan1 = planAssignments(state, reviewers, {}, { time: 0 });
  applyEvent(state, plan1.event);
  assert.deepEqual(
    plan1.certificate.assignments.map((a) => [a.caseId, a.start]),
    [['LOW', 3]]
  );

  const ev2 = openCase(state, reviewers, { caseId: 'HIGH', dept: 'd', risk: 9, deadline: 8, skill: 'echo', duration: 4, time: 1 });
  applyEvent(state, ev2);
  const plan2 = planAssignments(state, reviewers, {}, { time: 1 });
  applyEvent(state, plan2.event);
  const cert = plan2.certificate;
  assert.deepEqual(
    cert.assignments.map((a) => [a.caseId, a.start]),
    [['HIGH', 3]]
  );
  assert.equal(cert.rejections.find((r) => r.caseId === 'LOW').code, 'PREEMPTED');
  assert.deepEqual(cert.preemptions, [{ preempted: 'LOW', by: 'HIGH', reason: 'replan' }]);
  assert.deepEqual(cert.compensations, [{ caseId: 'LOW', credit: 5 }]);
  assert.equal(state.cases.LOW.credit, 5, 'compensation credit recorded on the case');
});

test('certificate hash chains into the state hash', () => {
  const state = createState();
  open(state, 'H1');
  const before = state.certHash;
  const plan = planAssignments(state, [REVIEWERS[0]], {}, { time: 0 });
  assert.equal(plan.certificate.prevHash, before);
  applyEvent(state, plan.event);
  assert.notEqual(state.certHash, before);
  assert.equal(state.certificates.length, 1);
  assert.equal(state.certificates[0].hash, plan.certificate.hash);
});
