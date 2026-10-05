import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  run,
  selectMatch,
  undoAll,
  interpretTrajectory,
  validateRules,
  type Rule,
} from '../src/rewrite.js';

test('selection: leftmost position wins over longer LHS elsewhere', () => {
  const rules: Rule[] = [
    { id: 1, lhs: 'aaa', rhs: 'x' },
    { id: 2, lhs: 'b', rhs: 'y' },
  ];
  // 'b' sits at position 0, 'aaa' at position 1 -> rule 2 fires first.
  const match = selectMatch(rules, 'baaa');
  assert.equal(match?.rule.id, 2);
  assert.equal(match?.position, 0);
});

test('selection: longest LHS breaks a same-position tie', () => {
  const rules: Rule[] = [
    { id: 1, lhs: 'a', rhs: 'x' },
    { id: 2, lhs: 'ab', rhs: 'y' },
  ];
  const match = selectMatch(rules, 'ab');
  assert.equal(match?.rule.id, 2);
});

test('selection: smallest rule id breaks a same-position same-length tie', () => {
  const rules: Rule[] = [
    { id: 5, lhs: 'a', rhs: 'x' },
    { id: 2, lhs: 'a', rhs: 'y' },
  ];
  const match = selectMatch(rules, 'a');
  assert.equal(match?.rule.id, 2);
  const result = run(rules, 'a', { budget: 10 });
  assert.equal(result.final, 'y');
});

test('selection: returns null at normal form', () => {
  assert.equal(selectMatch([{ id: 1, lhs: 'z', rhs: 'w' }], 'abc'), null);
});

test('rules may shrink and grow the string', () => {
  const shrink = run([{ id: 1, lhs: 'aa', rhs: 'a' }], 'aaaa', { budget: 10 });
  assert.equal(shrink.status.kind, 'normal-form');
  assert.equal(shrink.final, 'a');

  const grow = run([{ id: 1, lhs: 'a', rhs: 'aa' }], 'a', { budget: 4 });
  assert.equal(grow.status.kind, 'budget-exhausted');
  assert.equal(grow.final, 'aaaaa');
});

test('inverse deltas undo every step back to the original input', () => {
  const rules: Rule[] = [
    { id: 1, lhs: 'ab', rhs: 'ba' },
    { id: 2, lhs: 'aa', rhs: 'b' },
  ];
  const result = run(rules, 'aaba', { budget: 50 });
  assert.equal(result.status.kind, 'normal-form');
  assert.ok(result.steps.length > 0);
  assert.equal(undoAll(result.final, result.inverseDeltas), 'aaba');
});

test('undoAll rejects an inverse delta that does not apply', () => {
  assert.throws(
    () => undoAll('xyz', [{ step: 1, ruleId: 1, position: 0, removed: 'a', inserted: 'q' }]),
    /does not apply/,
  );
});

test('provenance tracks original indices and produced characters', () => {
  const result = run([{ id: 7, lhs: 'a', rhs: 'cd' }], 'ab', { budget: 10 });
  assert.equal(result.final, 'cdb');
  assert.deepEqual(result.provenance, [
    { ch: 'c', origin: { kind: 'produced', ruleId: 7, step: 1 } },
    { ch: 'd', origin: { kind: 'produced', ruleId: 7, step: 1 } },
    { ch: 'b', origin: { kind: 'original', index: 1 } },
  ]);
});

test('provenance survives length-changing multi-step runs', () => {
  const rules: Rule[] = [
    { id: 1, lhs: 'a', rhs: 'bb' },
    { id: 2, lhs: 'bbb', rhs: 'c' },
  ];
  const result = run(rules, 'aa', { budget: 20 });
  assert.equal(result.final, 'cb');
  assert.deepEqual(
    result.provenance.map((t) => t.origin),
    [
      { kind: 'produced', ruleId: 2, step: 3 },
      { kind: 'produced', ruleId: 1, step: 2 },
    ],
  );
});

test('full-state repetition yields cycle evidence', () => {
  const rules: Rule[] = [
    { id: 1, lhs: 'a', rhs: 'b' },
    { id: 2, lhs: 'b', rhs: 'a' },
  ];
  const result = run(rules, 'a', { budget: 100 });
  assert.deepEqual(result.status, {
    kind: 'cycle',
    steps: 2,
    cycleStart: 0,
    cycleLength: 2,
  });
  assert.equal(result.cycleEvidence?.length, 2);
  // Replaying the evidence from the cycle start returns to the same state.
  const replayed = result.cycleEvidence!.reduce(
    (state, s) => state.slice(0, s.position) + s.inserted + state.slice(s.position + s.removed.length),
    'a',
  );
  assert.equal(replayed, 'a');
});

test('cycle detection works with an offset before the loop', () => {
  const rules: Rule[] = [
    { id: 1, lhs: 'xa', rhs: 'a' },
    { id: 2, lhs: 'a', rhs: 'ab' },
    { id: 3, lhs: 'ab', rhs: 'a' },
  ];
  const result = run(rules, 'xa', { budget: 100 });
  assert.equal(result.status.kind, 'cycle');
  if (result.status.kind === 'cycle') {
    assert.equal(result.status.cycleStart, 1);
    assert.equal(result.status.cycleLength, 2);
  }
});

test('normal form when no rule applies', () => {
  const result = run([{ id: 1, lhs: 'z', rhs: 'w' }], 'abc', { budget: 10 });
  assert.deepEqual(result.status, { kind: 'normal-form', steps: 0 });
  assert.equal(result.final, 'abc');
  assert.equal(result.crossCheck, null);
});

test('budget exhaustion triggers interpreter cross-check', () => {
  const result = run([{ id: 1, lhs: 'a', rhs: 'aa' }], 'a', { budget: 10 });
  assert.deepEqual(result.status, { kind: 'budget-exhausted', steps: 10 });
  assert.equal(result.final.length, 11);
  assert.deepEqual(result.crossCheck, {
    interpreterAgrees: true,
    firstDivergenceStep: null,
    undoRestoresOriginal: true,
  });
});

test('cross-check agrees on a mixed grow/shrink system', () => {
  // a -> bb grows, bbb -> c shrinks; both fire within the budget window.
  const rules: Rule[] = [
    { id: 1, lhs: 'a', rhs: 'bb' },
    { id: 2, lhs: 'bbb', rhs: 'c' },
  ];
  const result = run(rules, 'aaaaa', { budget: 5 });
  assert.equal(result.status.kind, 'budget-exhausted');
  assert.deepEqual(
    ['aaaaa', ...result.steps.map((s) => s.stateAfter)],
    ['aaaaa', 'bbaaaa', 'bbbbaaa', 'cbaaa', 'cbbbaa', 'ccaa'],
  );
  assert.equal(result.crossCheck?.interpreterAgrees, true);
  assert.equal(result.crossCheck?.undoRestoresOriginal, true);
  // Independent interpreter reproduces the same trajectory.
  const trajectory = interpretTrajectory(rules, 'aaaaa', 5);
  assert.deepEqual(['aaaaa', ...result.steps.map((s) => s.stateAfter)], trajectory);
});

test('cross-check can be disabled', () => {
  const result = run([{ id: 1, lhs: 'a', rhs: 'aa' }], 'a', {
    budget: 3,
    crossCheckOnBudgetExhaustion: false,
  });
  assert.equal(result.status.kind, 'budget-exhausted');
  assert.equal(result.crossCheck, null);
});

test('rule validation rejects empty LHS and duplicate ids', () => {
  assert.throws(() => validateRules([{ id: 1, lhs: '', rhs: 'a' }]), /empty left-hand side/);
  assert.throws(
    () =>
      validateRules([
        { id: 1, lhs: 'a', rhs: 'b' },
        { id: 1, lhs: 'c', rhs: 'd' },
      ]),
    /duplicate rule id/,
  );
});
