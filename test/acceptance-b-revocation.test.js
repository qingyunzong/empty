import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schedule } from '../src/scheduler.js';
import { MAP, grant, task } from '../fixtures/helpers.mjs';

// Acceptance B: revocation segments the grant by effective time. A task that
// already occupies the aisle keeps a temporary pass until completion; new
// tasks after the revocation must not reuse it.
const grants = [
  grant('G1', { zone: undefined, aisle: 'A-R-1', from: 0, to: 100 }),
  {
    id: 'R1',
    kind: 'revoke',
    target: 'G1',
    at: 50,
    clock: { node: 'ops', counter: 2 },
    parents: ['G1'],
  },
];

test('B: occupying task keeps a temporary pass until completion', () => {
  const old = task('T-OLD', {
    target: { aisle: 'A-R-1' },
    time: 10,
    completeTime: 80, // still inside when R1 takes effect at 50
    parents: ['G1'],
  });
  const { plan } = schedule({ map: MAP, tasks: [old], grants });
  assert.equal(plan[0].decision, 'allow');
  assert.deepEqual(plan[0].tempPass, { until: 80, revoke: 'R1', reusable: false });
});

test('B: new task after revocation is denied and cannot reuse the pass', () => {
  const old = task('T-OLD', {
    target: { aisle: 'A-R-1' },
    time: 10,
    completeTime: 80,
    parents: ['G1'],
  });
  const fresh = task('T-NEW', {
    target: { aisle: 'A-R-1' },
    time: 60,
    completeTime: 70,
    parents: ['R1'],
  });
  const { plan, deny } = schedule({ map: MAP, tasks: [old, fresh], grants });
  assert.equal(plan.length, 1);
  const denied = deny.find((r) => r.task === 'T-NEW');
  assert.ok(denied, 'new task must be denied');
  assert.ok(denied.reasons.includes('grant-revoked'));
  assert.equal(denied.tempPass, undefined, 'new task must not inherit the temp pass');
});

test('B: task before revocation without overlap gets no temp pass', () => {
  const early = task('T-EARLY', {
    target: { aisle: 'A-R-1' },
    time: 10,
    completeTime: 40,
    parents: ['G1'],
  });
  const { plan } = schedule({ map: MAP, tasks: [early], grants });
  assert.equal(plan[0].decision, 'allow');
  assert.equal(plan[0].tempPass, undefined);
});

test('B: counterexample names the revocation whose deletion legalizes the task', () => {
  const fresh = task('T-NEW', {
    target: { aisle: 'A-R-1' },
    time: 60,
    completeTime: 70,
    parents: ['R1'],
  });
  const { deny } = schedule({ map: MAP, tasks: [fresh], grants });
  assert.deepEqual(deny[0].counterexamples, [
    { removeRevoke: 'R1', grant: 'G1', restoredSegment: [0, 100], then: 'allow' },
  ]);
});

test('B: deleting the named revocation actually flips the decision (evidence check)', () => {
  const fresh = task('T-NEW', {
    target: { aisle: 'A-R-1' },
    time: 60,
    completeTime: 70,
    parents: ['G1'],
  });
  const withoutRevoke = grants.filter((g) => g.kind !== 'revoke');
  const { plan, deny } = schedule({ map: MAP, tasks: [fresh], grants: withoutRevoke });
  assert.equal(deny.length, 0);
  assert.equal(plan[0].decision, 'allow');
});
