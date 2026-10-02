import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, verifyRecord, applyCounterexample } from '../src/evaluate.js';
import { makePolicy, BASE_POLICY } from './support/helpers.js';

const policies = makePolicy(BASE_POLICY);

const DENY_REQ = { id: 'c1', subject: 'alice', device: 'press1', action: 'heatUp', time: '2026-01-05T10:00:00Z' };
const ALLOW_REQ = { id: 'c2', subject: 'bob', device: 'press2', action: 'openMold', time: '2026-01-05T10:00:00Z' };

test('C: a forged should-deny-but-allow record is detected', () => {
  const genuine = evaluate(policies, DENY_REQ);
  assert.equal(genuine.decision, 'deny');
  assert.equal(genuine.reason, 'conflict-deny');

  const forged = { ...genuine, decision: 'allow' };
  const check = verifyRecord(policies, DENY_REQ, forged);
  assert.equal(check.ok, false);
  assert.ok(check.problems.some((p) => p.includes('decision mismatch')));
});

test('C: genuine records pass verification', () => {
  for (const req of [DENY_REQ, ALLOW_REQ]) {
    const record = evaluate(policies, req);
    const check = verifyRecord(policies, req, record);
    assert.ok(check.ok, check.problems.join('; '));
  }
});

test('C: applying a counterexample flips the decision; a corrupted one is caught', () => {
  const record = evaluate(policies, ALLOW_REQ);
  assert.equal(record.decision, 'allow');

  const applied = applyCounterexample(policies, ALLOW_REQ, record.counterexample);
  const flipped = evaluate(applied.policies, applied.req);
  assert.equal(flipped.decision, 'deny');

  const corrupted = {
    ...record,
    counterexample: { kind: 'policy', change: { removeRules: ['r-does-not-exist'] }, resultingDecision: 'deny', verifies: true },
  };
  const check = verifyRecord(policies, ALLOW_REQ, corrupted);
  assert.equal(check.ok, false);
  assert.ok(check.problems.some((p) => p.includes('counterexample')));
});

test('C: tampered winner evidence is detected', () => {
  const record = evaluate(policies, ALLOW_REQ);
  const tampered = { ...record, winners: ['r-wild-deny'] };
  const check = verifyRecord(policies, ALLOW_REQ, tampered);
  assert.equal(check.ok, false);
  assert.ok(check.problems.some((p) => p.includes('winners mismatch')));
});
