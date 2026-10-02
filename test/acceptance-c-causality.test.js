import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schedule } from '../src/scheduler.js';
import { MAP, grant, task } from '../fixtures/helpers.mjs';

// Acceptance C: "先见授权后派单" is judged by the Lamport causal DAG, not by
// file order or wall-clock arrival. Events may arrive out of order offline.
test('C: dispatch that causally saw the grant is allowed, chain is emitted', () => {
  const grants = [
    grant('G1', { zone: 'Z-COLD', clock: { node: 'ops', counter: 1 } }),
    grant('G2', {
      zone: 'Z-CHARGE',
      clock: { node: 'ops', counter: 2 },
      parents: ['G1'],
    }),
  ];
  const t = task('T1', {
    target: { zone: 'Z-CHARGE' },
    clock: { node: 'agv-1', counter: 3 },
    parents: ['G2'],
  });
  const { plan } = schedule({ map: MAP, tasks: [t], grants });
  assert.equal(plan[0].decision, 'allow');
  assert.deepEqual(plan[0].causalChain, ['G2', 'T1']);
});

test('C: concurrent dispatch (grant not in causal past) is denied', () => {
  // Lamport counter of the task is higher, but the grant is NOT an ancestor:
  // higher counter alone does not prove "saw the grant before dispatch".
  const grants = [grant('G1', { zone: 'Z-COLD', clock: { node: 'ops', counter: 1 } })];
  const t = task('T1', {
    target: { zone: 'Z-COLD' },
    clock: { node: 'agv-1', counter: 9 },
    parents: [], // concurrent with G1
  });
  const { plan, deny } = schedule({ map: MAP, tasks: [t], grants });
  assert.equal(plan.length, 0);
  assert.ok(deny[0].reasons.includes('grant-not-causally-visible'));
});

test('C: out-of-order arrival still resolves causality from the DAG', () => {
  // Grant appears AFTER the task in the input files, but the task's parents
  // reference it: causality comes from parents, not file order.
  const grants = [grant('G1', { zone: 'Z-COLD' })];
  const t = task('T1', { target: { zone: 'Z-COLD' }, parents: ['G1'] });
  const { plan } = schedule({ map: MAP, tasks: [t], grants: [...grants].reverse() });
  assert.equal(plan[0].decision, 'allow');
  assert.deepEqual(plan[0].causalChain, ['G1', 'T1']);
});

test('C: causal chain spans intermediate events', () => {
  const grants = [
    grant('G1', { zone: 'Z-COLD' }),
    grant('G2', {
      kind: 'grant',
      zone: 'Z-OPEN',
      clock: { node: 'ops', counter: 2 },
      parents: ['G1'],
    }),
  ];
  const t = task('T1', {
    target: { zone: 'Z-COLD' },
    clock: { node: 'agv-1', counter: 3 },
    parents: ['G2'], // saw G2, which saw G1 -> transitively saw G1
  });
  const { plan } = schedule({ map: MAP, tasks: [t], grants });
  assert.equal(plan[0].decision, 'allow');
  assert.deepEqual(plan[0].causalChain, ['G1', 'G2', 'T1']);
});
