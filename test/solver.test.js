import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solve } from '../src/solver.js';
import { makeCertificate, verifyCertificate } from '../src/certificate.js';
import { canon } from '../src/canon.js';

test('acceptance 1: tied optimal plans resolve to deterministic lexicographic output', () => {
  // Two identical independent jobs, two machines: (a->m0,b->m1) and
  // (a->m1,b->m0) are both optimal with makespan 1.
  const inst = {
    machines: 2,
    memoryLimit: 10,
    steps: [
      { id: 'a', params: ['x'], memory: 1, duration: 1 },
      { id: 'b', params: ['x'], memory: 1, duration: 1 },
    ],
    edges: [],
    compat: [],
  };
  const r1 = solve(inst);
  const r2 = solve(inst);
  assert.equal(r1.status, 'SAT');
  assert.equal(r1.plan.makespan, 1);
  // Deterministic across runs.
  assert.equal(canon(r1), canon(r2));
  // Lexicographically smallest plan: a on machine 0, b on machine 1.
  assert.deepEqual(
    r1.plan.jobs.map((j) => [j.step, j.machine]),
    [['a', 0], ['b', 1]],
  );
  // And the full certificate is byte-identical across runs.
  assert.equal(canon(r1.entries), canon(r2.entries));
});

test('UNSAT: single job exceeds memory limit', () => {
  const inst = {
    machines: 1,
    memoryLimit: 4,
    steps: [{ id: 'a', params: ['x'], memory: 5, duration: 1 }],
  };
  const r = solve(inst);
  assert.equal(r.status, 'UNSAT');
  assert.equal(r.plan, null);
});

test('UNSAT: incompatible pins via compat matrix', () => {
  const inst = {
    machines: 1,
    memoryLimit: 10,
    steps: [
      { id: 'a', params: ['x', 'y'], memory: 1, duration: 1 },
      { id: 'b', params: ['u', 'v'], memory: 1, duration: 1 },
    ],
    edges: [],
    compat: [{ between: ['a', 'b'], allow: [['x', 'u']] }],
  };
  const r = solve(inst, { pins: { a: 'y' } });
  assert.equal(r.status, 'UNSAT');
});

test('PENDING: node budget exhaustion keeps partial certificate, never UNSAT', () => {
  const inst = {
    machines: 2,
    memoryLimit: 10,
    steps: [
      { id: 'a', params: ['x', 'y'], memory: 1, duration: 1 },
      { id: 'b', params: ['x', 'y'], memory: 1, duration: 1 },
      { id: 'c', params: ['x'], memory: 1, duration: 1 },
    ],
    edges: [['a', 'b']],
    compat: [],
  };
  const r = solve(inst, { maxNodes: 1 });
  assert.equal(r.status, 'PENDING');
  assert.ok(r.entries.length > 0, 'partial certificate retained');
  assert.notEqual(r.status, 'UNSAT');
  // Partial certificate still verifies as a valid (partial) replay.
  const cert = makeCertificate(inst, {}, r);
  assert.deepEqual(verifyCertificate(cert), { status: 'VALID' });
});

test('PENDING: certificate byte budget exhaustion', () => {
  const inst = {
    machines: 1,
    memoryLimit: 10,
    steps: [
      { id: 'a', params: ['x', 'y'], memory: 1, duration: 1 },
      { id: 'b', params: ['x', 'y'], memory: 1, duration: 1 },
    ],
  };
  const full = solve(inst);
  const r = solve(inst, { maxCertBytes: 400 });
  assert.equal(r.status, 'PENDING');
  assert.ok(r.entries.length < full.entries.length);
  const cert = makeCertificate(inst, {}, r);
  assert.deepEqual(verifyCertificate(cert), { status: 'VALID' });
});

test('certificate verify: valid certificate passes, tampered fails', () => {
  const inst = {
    machines: 2,
    memoryLimit: 3,
    steps: [
      { id: 'a', params: ['x', 'y'], memory: 2, duration: 2 },
      { id: 'b', params: ['u'], memory: 2, duration: 1 },
      { id: 'c', params: ['v'], memory: 1, duration: 1 },
    ],
    edges: [['a', 'c']],
    compat: [],
  };
  const r = solve(inst);
  assert.equal(r.status, 'SAT');
  const cert = makeCertificate(inst, {}, r);
  assert.deepEqual(verifyCertificate(cert), { status: 'VALID' });

  // Tamper with a decision entry.
  const bad = JSON.parse(JSON.stringify(cert));
  const decide = bad.entries.find((e) => e.entry.type === 'decide');
  decide.entry.machine = 99;
  const verdict = verifyCertificate(bad);
  assert.equal(verdict.status, 'INVALID');

  // Tamper with the plan.
  const bad2 = JSON.parse(JSON.stringify(cert));
  bad2.plan.makespan -= 1;
  assert.equal(verifyCertificate(bad2).status, 'INVALID');
});

test('solver respects pins and finds optimal makespan under memory pressure', () => {
  const inst = {
    machines: 2,
    memoryLimit: 2,
    steps: [
      { id: 'a', params: ['x'], memory: 2, duration: 2 },
      { id: 'b', params: ['u'], memory: 2, duration: 2 },
    ],
    edges: [],
    compat: [],
  };
  // Two jobs of memory 2 with limit 2 cannot overlap: makespan 4.
  const r = solve(inst);
  assert.equal(r.status, 'SAT');
  assert.equal(r.plan.makespan, 4);
  assert.ok(r.plan.peak <= 2);
});
