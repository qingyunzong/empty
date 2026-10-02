import test from 'node:test';
import assert from 'node:assert/strict';
import { validateInstance } from '../src/instance.js';
import { solve } from '../src/solver.js';
import { verifySolution } from '../src/verify.js';

// Base instance whose optimum contains exactly one preemption.
const INSTANCE = {
  machines: [{ id: 'M1' }, { id: 'M2' }],
  shifts: [{ id: 'S1', start: 0, end: 12, quotas: { A: 5, B: 5 } }],
  orders: [
    { id: 'B1', release: 0, duration: 4, deadline: 8, family: 'B', priority: 'low', machines: ['M1'] },
    { id: 'C1', release: 2, duration: 3, deadline: 5, family: 'A', priority: 'critical', machines: ['M1'] },
    { id: 'D1', release: 0, duration: 2, deadline: 10, family: 'A', priority: 'low', machines: ['M2'] },
  ],
};

function genuineSolution() {
  const inst = validateInstance(INSTANCE);
  const sol = solve(inst);
  assert.equal(sol.status, 'optimal');
  assert.equal(sol.certificate.ok, true);
  return { inst, sol };
}

function checkNames(cert) {
  return cert.checks.filter((c) => !c.ok).map((c) => c.name);
}

test('verifier accepts the genuine certificate', () => {
  const { inst, sol } = genuineSolution();
  const cert = verifySolution(inst, sol);
  assert.equal(cert.ok, true);
  assert.ok(cert.checks.length >= 10, 'certificate is itemized');
});

test('verifier rejects production before release', () => {
  const inst = validateInstance({
    machines: [{ id: 'M1' }],
    shifts: [{ id: 'S1', start: 0, end: 10, quotas: { A: 10 } }],
    orders: [{ id: 'J1', release: 5, duration: 2, deadline: 9, family: 'A', priority: 'low', machines: ['M1'] }],
  });
  // J1 is scheduled at [4,6) although it is only released at 5
  const forged = {
    status: 'optimal',
    objective: { totalTardiness: 0 },
    orders: [{ id: 'J1', machine: 'M1', segments: [{ start: 4, end: 6 }], completion: 6, deadline: 9, tardiness: 0, preemptions: 0 }],
    machines: [{ id: 'M1', slices: [{ start: 4, end: 6, type: 'production', order: 'J1' }] }],
    quotaUsage: [{ shift: 'S1', family: 'A', used: 2, capacity: 10 }],
    preemptions: { total: 0, byOrder: {}, events: [] },
  };
  const cert = verifySolution(inst, forged);
  assert.equal(cert.ok, false);
  assert.ok(checkNames(cert).includes('release-respected'));
});

test('verifier rejects quota overuse', () => {
  const inst = validateInstance({
    machines: [{ id: 'M1' }],
    shifts: [{ id: 'S1', start: 0, end: 10, quotas: { A: 1 } }],
    orders: [{ id: 'J1', release: 0, duration: 2, deadline: 9, family: 'A', priority: 'low', machines: ['M1'] }],
  });
  // forged schedule uses 2 slots of family A although the shift quota is 1
  const forged = {
    status: 'optimal',
    objective: { totalTardiness: 0 },
    orders: [{ id: 'J1', machine: 'M1', segments: [{ start: 0, end: 2 }], completion: 2, deadline: 9, tardiness: 0, preemptions: 0 }],
    machines: [{ id: 'M1', slices: [{ start: 0, end: 2, type: 'production', order: 'J1' }] }],
    quotaUsage: [{ shift: 'S1', family: 'A', used: 2, capacity: 1 }],
    preemptions: { total: 0, byOrder: {}, events: [] },
  };
  const cert = verifySolution(inst, forged);
  assert.equal(cert.ok, false);
  assert.ok(checkNames(cert).includes('shift-quotas-respected'));
});

test('verifier rejects a third preemption of the same order', () => {
  const inst = validateInstance({
    machines: [{ id: 'M1' }],
    shifts: [{ id: 'S1', start: 0, end: 20, quotas: { A: 20, B: 20 } }],
    orders: [
      { id: 'B', release: 0, duration: 5, deadline: 30, family: 'B', priority: 'low', machines: ['M1'] },
      { id: 'C1', release: 1, duration: 1, deadline: 30, family: 'A', priority: 'critical', machines: ['M1'] },
      { id: 'C2', release: 2, duration: 1, deadline: 30, family: 'A', priority: 'critical', machines: ['M1'] },
      { id: 'C3', release: 3, duration: 1, deadline: 30, family: 'A', priority: 'critical', machines: ['M1'] },
    ],
  });
  // hand-built schedule that preempts B three times (illegal: max 2)
  const forged = {
    status: 'optimal',
    objective: { totalTardiness: 0 },
    orders: [
      { id: 'B', machine: 'M1', segments: [{ start: 0, end: 1 }, { start: 3, end: 4 }, { start: 5, end: 6 }, { start: 7, end: 10 }], completion: 10, deadline: 30, tardiness: 0, preemptions: 3 },
      { id: 'C1', machine: 'M1', segments: [{ start: 2, end: 3 }], completion: 3, deadline: 30, tardiness: 0, preemptions: 0 },
      { id: 'C2', machine: 'M1', segments: [{ start: 4, end: 5 }], completion: 5, deadline: 30, tardiness: 0, preemptions: 0 },
      { id: 'C3', machine: 'M1', segments: [{ start: 6, end: 7 }], completion: 7, deadline: 30, tardiness: 0, preemptions: 0 },
    ],
    machines: [{
      id: 'M1',
      slices: [
        { start: 0, end: 1, type: 'production', order: 'B' },
        { start: 1, end: 2, type: 'changeover', preempted: 'B', by: 'C1' },
        { start: 2, end: 3, type: 'production', order: 'C1' },
        { start: 3, end: 4, type: 'production', order: 'B' },
        { start: 4, end: 5, type: 'changeover', preempted: 'B', by: 'C2' },
        // C2 should start at 5 but B is scheduled there instead: also protocol noise
        { start: 5, end: 6, type: 'production', order: 'B' },
        { start: 6, end: 7, type: 'changeover', preempted: 'B', by: 'C3' },
        { start: 7, end: 8, type: 'production', order: 'C3' },
        { start: 8, end: 10, type: 'production', order: 'B' },
      ],
    }],
    quotaUsage: [{ shift: 'S1', family: 'A', used: 3, capacity: 20 }, { shift: 'S1', family: 'B', used: 5, capacity: 20 }],
    preemptions: {
      total: 3,
      byOrder: { B: 3 },
      events: [
        { slot: 1, machine: 'M1', preempted: 'B', by: 'C1' },
        { slot: 4, machine: 'M1', preempted: 'B', by: 'C2' },
        { slot: 6, machine: 'M1', preempted: 'B', by: 'C3' },
      ],
    },
  };
  const cert = verifySolution(inst, forged);
  assert.equal(cert.ok, false);
  assert.ok(checkNames(cert).includes('preemption-limit-two'));
});

test('verifier rejects preemption by a non-critical order', () => {
  const { inst, sol } = genuineSolution();
  const forged = structuredClone(sol);
  const m1 = forged.machines.find((m) => m.id === 'M1');
  const changeover = m1.slices.find((s) => s.type === 'changeover');
  changeover.by = 'D1'; // D1 is low priority
  const cert = verifySolution(inst, forged);
  assert.equal(cert.ok, false);
  assert.ok(checkNames(cert).includes('preemption-protocol'));
});

test('verifier rejects an order dropped from the schedule', () => {
  const { inst, sol } = genuineSolution();
  const forged = structuredClone(sol);
  forged.machines.find((m) => m.id === 'M2').slices = []; // D1 vanished
  const cert = verifySolution(inst, forged);
  assert.equal(cert.ok, false);
  assert.ok(checkNames(cert).includes('all-orders-complete-exact-duration'));
});

test('verifier rejects misreported preemption counts', () => {
  const { inst, sol } = genuineSolution();
  const forged = structuredClone(sol);
  forged.preemptions.total = 0;
  const cert = verifySolution(inst, forged);
  assert.equal(cert.ok, false);
  assert.ok(checkNames(cert).includes('preemption-records-accurate'));
});

test('verifier rejects production outside every shift', () => {
  const { inst, sol } = genuineSolution();
  const forged = structuredClone(sol);
  const m1 = forged.machines.find((m) => m.id === 'M1');
  m1.slices.push({ start: 12, end: 13, type: 'production', order: 'B1' }); // shift ends at 12
  const cert = verifySolution(inst, forged);
  assert.equal(cert.ok, false);
  assert.ok(checkNames(cert).includes('production-within-shifts'));
});
