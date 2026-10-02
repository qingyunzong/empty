'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadPolicies,
  evaluateRequest,
  evaluateInternal,
  findCycles,
  CycleError,
  InputError,
  verifyCounterexample,
} = require('../src/index');

function basePolicies(rules, extra = {}) {
  return loadPolicies({
    roles: { worker: {}, operator: { inherits: ['worker'] }, lead: { inherits: ['operator'] } },
    zones: { hall: {}, cell: { inherits: ['hall'] } },
    subjects: { alice: { roles: ['operator'] }, carol: { roles: ['lead'] } },
    devices: { press: { zone: 'cell' } },
    rules,
    ...extra,
  });
}

const REQ = { id: 'q1', subject: 'alice', device: 'press', action: 'open_mold', time: '2026-10-01T00:00:00Z' };

test('dual-chain inheritance merge: nearest specific rule wins', () => {
  const policies = basePolicies([
    { id: 'wild', action: 'open_mold', effect: 'allow' },
    { id: 'by-role', action: 'open_mold', effect: 'deny', role: 'worker' },
    { id: 'by-zone', action: 'open_mold', effect: 'allow', zone: 'hall' },
    { id: 'specific', action: 'open_mold', effect: 'allow', role: 'operator', zone: 'cell' },
  ]);
  const { record } = evaluateInternal(policies, REQ);
  assert.equal(record.decision, 'allow');
  assert.deepEqual(record.rulePath.map((r) => r.ruleId), ['specific']);
  assert.deepEqual(
    record.overridden.map((o) => o.ruleId).sort(),
    ['by-role', 'by-zone', 'wild'].sort()
  );
});

test('rule path exposes role and zone inheritance chains', () => {
  const policies = basePolicies([
    { id: 'r', action: 'open_mold', effect: 'allow', role: 'worker', zone: 'hall' },
  ]);
  const { record } = evaluateInternal(policies, REQ);
  assert.deepEqual(record.rulePath[0].rolePath, ['operator', 'worker']);
  assert.deepEqual(record.rulePath[0].zonePath, ['cell', 'hall']);
});

test('same-specificity allow/deny conflict defaults to deny with certificate', () => {
  const policies = basePolicies([
    { id: 'a', action: 'open_mold', effect: 'allow', role: 'operator', zone: 'cell' },
    { id: 'd', action: 'open_mold', effect: 'deny', role: 'operator', zone: 'cell' },
  ]);
  const { record } = evaluateInternal(policies, REQ);
  assert.equal(record.decision, 'deny');
  assert.equal(record.reason, 'conflict_default_deny');
  assert.equal(record.conflict.resolution, 'deny');
  assert.deepEqual(
    record.conflict.rules.map((r) => r.ruleId).sort(),
    ['a', 'd']
  );
});

test('no matching rule defaults to deny (interlock safe default)', () => {
  const policies = basePolicies([
    { id: 'r', action: 'heat_up', effect: 'allow', role: 'operator' },
  ]);
  const { record } = evaluateInternal(policies, REQ);
  assert.equal(record.decision, 'deny');
  assert.equal(record.reason, 'no_matching_rule');
});

test('time window is inclusive at both ends', () => {
  const rules = [
    {
      id: 'w',
      action: 'open_mold',
      effect: 'allow',
      role: 'operator',
      window: { start: '2026-10-01T08:00:00Z', end: '2026-10-01T16:00:00Z' },
    },
  ];
  const policies = basePolicies(rules);
  const at = (time) => evaluateInternal(policies, { ...REQ, time }).record.decision;
  assert.equal(at('2026-10-01T08:00:00Z'), 'allow');
  assert.equal(at('2026-10-01T16:00:00Z'), 'allow');
  assert.equal(at('2026-10-01T07:59:59Z'), 'deny');
  assert.equal(at('2026-10-01T16:00:01Z'), 'deny');
});

test('revokeAt only affects requests at/after the revocation point', () => {
  const policies = basePolicies([
    { id: 'r', action: 'open_mold', effect: 'allow', role: 'operator', revokeAt: '2026-10-01T12:00:00Z' },
  ]);
  const at = (time) => evaluateInternal(policies, { ...REQ, time }).record.decision;
  assert.equal(at('2026-10-01T11:59:59Z'), 'allow');
  assert.equal(at('2026-10-01T12:00:00Z'), 'deny');
  assert.equal(at('2026-10-02T00:00:00Z'), 'deny');
});

test('retroactive revocation invalidates authorizations before the revocation point', () => {
  const policies = basePolicies([
    {
      id: 'estop',
      action: 'open_mold',
      effect: 'allow',
      role: 'operator',
      retroactive: true,
      revokeAt: '2026-10-01T12:00:00Z',
    },
  ]);
  const { record } = evaluateInternal(policies, { ...REQ, time: '2026-10-01T00:00:00Z' });
  assert.equal(record.decision, 'deny');
  assert.deepEqual(record.retroactivelyRevoked, ['estop']);
});

test('counterexample flips an allow decision and verifies', () => {
  const policies = basePolicies([
    { id: 'r', action: 'open_mold', effect: 'allow', role: 'operator', zone: 'cell' },
  ]);
  const record = evaluateRequest(policies, REQ);
  assert.equal(record.decision, 'allow');
  assert.equal(record.counterexample.flips, true);
  assert.equal(record.counterexample.resultingDecision, 'deny');
  assert.equal(verifyCounterexample(policies, REQ, record.counterexample).valid, true);
});

test('counterexample flips a deny decision and verifies', () => {
  const policies = basePolicies([
    { id: 'r', action: 'open_mold', effect: 'deny', role: 'operator', zone: 'cell' },
  ]);
  const record = evaluateRequest(policies, REQ);
  assert.equal(record.decision, 'deny');
  assert.equal(record.counterexample.flips, true);
  assert.equal(record.counterexample.resultingDecision, 'allow');
  assert.equal(verifyCounterexample(policies, REQ, record.counterexample).valid, true);
});

test('cycle detection lists the cycle for roles and zones', () => {
  assert.throws(
    () =>
      loadPolicies({
        roles: { a: { inherits: ['b'] }, b: { inherits: ['c'] }, c: { inherits: ['a'] } },
        rules: [],
      }),
    (err) => {
      assert.ok(err instanceof CycleError);
      assert.equal(err.exitCode, 4);
      assert.match(err.message, /a -> b -> c -> a/);
      return true;
    }
  );
  assert.throws(
    () =>
      loadPolicies({
        zones: { x: { inherits: ['y'] }, y: { inherits: ['x'] } },
        rules: [],
      }),
    (err) => {
      assert.ok(err instanceof CycleError);
      assert.match(err.message, /x -> y -> x|y -> x -> y/);
      return true;
    }
  );
});

test('self-inheritance is reported as a cycle', () => {
  const cycles = findCycles(new Map([['a', ['a']]]));
  assert.deepEqual(cycles, [['a', 'a']]);
});

test('invalid schema raises InputError (exit code 2)', () => {
  assert.throws(() => loadPolicies({ rules: [{ id: 'x' }] }), (err) => {
    assert.ok(err instanceof InputError);
    assert.equal(err.exitCode, 2);
    return true;
  });
  assert.throws(
    () => loadPolicies({ roles: { a: { inherits: ['ghost'] } }, rules: [] }),
    InputError
  );
  assert.throws(
    () =>
      loadPolicies({
        roles: { a: {} },
        rules: [{ id: 'r', action: 'x', effect: 'allow', window: { start: 'bad', end: 'bad' } }],
      }),
    InputError
  );
});
