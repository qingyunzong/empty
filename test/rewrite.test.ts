import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  interpret,
  rewrite,
  selectMatch,
  stateAt,
  undo,
  verifyTraceWithInterpreter,
} from '../src/index.js';
import type { Rule, Step, Trace } from '../src/index.js';

function ruleIds(trace: Trace): string[] {
  return trace.steps.map((step: Step) => step.ruleId);
}

describe('step selection: leftmost, longest lhs, rule id', () => {
  test('leftmost position wins regardless of rule order', () => {
    const rules: Rule[] = [
      { id: 'r-b', lhs: 'b', rhs: 'B' },
      { id: 'r-a', lhs: 'a', rhs: 'A' },
    ];
    const match = selectMatch(rules, 'ab');
    assert.ok(match !== null);
    assert.equal(match.rule.id, 'r-a');
    assert.equal(match.position, 0);
  });

  test('longest lhs wins at the same position', () => {
    const rules: Rule[] = [
      { id: 'r-short', lhs: 'a', rhs: 'x' },
      { id: 'r-long', lhs: 'ab', rhs: 'y' },
    ];
    const trace = rewrite(rules, 'ab');
    assert.deepEqual(ruleIds(trace), ['r-long']);
    assert.equal(trace.final, 'y');
    assert.equal(trace.outcome.kind, 'normal-form');
  });

  test('rule id breaks ties at same position and same lhs length', () => {
    const rules: Rule[] = [
      { id: 'r2', lhs: 'a', rhs: 'x' },
      { id: 'r1', lhs: 'a', rhs: 'y' },
    ];
    const trace = rewrite(rules, 'a');
    assert.deepEqual(ruleIds(trace), ['r1']);
    assert.equal(trace.final, 'y');
  });

  test('leftmost beats longer lhs further right', () => {
    const rules: Rule[] = [
      { id: 'r-long', lhs: 'bcd', rhs: 'X' },
      { id: 'r-short', lhs: 'a', rhs: 'Y' },
    ];
    const trace = rewrite(rules, 'abcd');
    assert.equal(trace.steps[0]!.ruleId, 'r-short');
    assert.equal(trace.steps[0]!.position, 0);
  });
});

describe('length-changing rules', () => {
  const rules: Rule[] = [
    { id: 'grow', lhs: 'ab', rhs: 'bba' },
    { id: 'shrink', lhs: 'bb', rhs: 'b' },
  ];

  test('rules may grow and shrink the string before closing', () => {
    const trace = rewrite(rules, 'ab');
    assert.deepEqual(
      trace.steps.map((step: Step) => step.after),
      ['bba', 'ba'],
    );
    assert.equal(trace.steps[0]!.after.length > trace.steps[0]!.before.length, true);
    assert.equal(trace.steps[1]!.after.length < trace.steps[1]!.before.length, true);
    assert.equal(trace.outcome.kind, 'normal-form');
    assert.equal(trace.final, 'ba');
  });

  test('deletion rules (empty rhs) are supported', () => {
    const trace = rewrite([{ id: 'del', lhs: 'x', rhs: '' }], 'axbx');
    assert.equal(trace.final, 'ab');
    assert.deepEqual(ruleIds(trace), ['del', 'del']);
  });
});

describe('inverse diff and provenance', () => {
  const rules: Rule[] = [
    { id: 'grow', lhs: 'ab', rhs: 'bba' },
    { id: 'shrink', lhs: 'bb', rhs: 'b' },
    { id: 'swap', lhs: 'ba', rhs: 'ab' },
  ];
  const trace = rewrite(rules, 'zabz');

  test('undo replays inverse diffs back to the original', () => {
    assert.equal(undo(trace), 'zabz');
    assert.equal(undo(trace), trace.original);
  });

  test('every step records source state and forms a chain', () => {
    assert.equal(trace.original, 'zabz');
    for (let i = 0; i < trace.steps.length; i++) {
      const step = trace.steps[i]!;
      assert.equal(step.before, stateAt(trace, i));
      assert.equal(step.after, stateAt(trace, i + 1));
      assert.equal(step.index, i);
      if (i > 0) {
        assert.equal(step.before, trace.steps[i - 1]!.after);
      }
    }
    assert.equal(stateAt(trace, trace.steps.length), trace.final);
  });

  test('each step records the inverse diff (removed/inserted at position)', () => {
    const first = trace.steps[0]!;
    assert.equal(first.ruleId, 'grow');
    assert.equal(first.position, 1);
    assert.equal(first.removed, 'ab');
    assert.equal(first.inserted, 'bba');
  });
});

describe('cycle detection', () => {
  test('full-state repetition yields cycle evidence from the initial state', () => {
    const rules: Rule[] = [
      { id: 'a2b', lhs: 'a', rhs: 'b' },
      { id: 'b2a', lhs: 'b', rhs: 'a' },
    ];
    const trace = rewrite(rules, 'a', { maxSteps: 100 });
    assert.equal(trace.outcome.kind, 'cycle');
    if (trace.outcome.kind !== 'cycle') return;
    const ev = trace.outcome.evidence;
    assert.equal(ev.state, 'a');
    assert.equal(ev.firstSeenAt, 0);
    assert.equal(ev.repeatedAt, 2);
    assert.equal(ev.cycleLength, 2);
    assert.deepEqual(
      ev.cycleSteps.map((step: Step) => step.ruleId),
      ['a2b', 'b2a'],
    );
  });

  test('cycle evidence pinpoints a loop entered after a transient', () => {
    const rules: Rule[] = [
      { id: 'del', lhs: 'x', rhs: '' },
      { id: 'a2b', lhs: 'a', rhs: 'b' },
      { id: 'b2a', lhs: 'b', rhs: 'a' },
    ];
    const trace = rewrite(rules, 'xa', { maxSteps: 100 });
    assert.equal(trace.outcome.kind, 'cycle');
    if (trace.outcome.kind !== 'cycle') return;
    const ev = trace.outcome.evidence;
    assert.equal(ev.state, 'a');
    assert.equal(ev.firstSeenAt, 1);
    assert.equal(ev.repeatedAt, 3);
    assert.equal(ev.cycleLength, 2);
    assert.equal(ev.cycleSteps.length, 2);
    assert.equal(undo(trace), 'xa');
  });
});

describe('budget exhaustion and interpreter cross-check', () => {
  test('unclosed run within budget is verified against the interpreter', () => {
    const rules: Rule[] = [{ id: 'dup', lhs: 'a', rhs: 'aa' }];
    const trace = rewrite(rules, 'a', { maxSteps: 5 });
    assert.equal(trace.outcome.kind, 'budget-exhausted');
    if (trace.outcome.kind !== 'budget-exhausted') return;
    assert.equal(trace.final, 'aaaaaa');
    assert.equal(trace.outcome.steps, 5);
    const verification = trace.outcome.verification;
    assert.equal(verification.checked, true);
    assert.equal(verification.consistent, true);
    assert.equal(verification.comparedStates, 6);
    assert.equal(verification.firstDivergence, null);
  });

  test('interpreter cross-check flags a tampered trace', () => {
    const rules: Rule[] = [{ id: 'dup', lhs: 'a', rhs: 'aa' }];
    const trace = rewrite(rules, 'a', { maxSteps: 3 });
    const tampered: Trace = {
      ...trace,
      steps: trace.steps.map((step: Step, i: number) =>
        i === 1 ? { ...step, after: 'tampered' } : step,
      ),
    };
    const verification = verifyTraceWithInterpreter(rules, tampered, 3);
    assert.equal(verification.checked, true);
    assert.equal(verification.consistent, false);
    assert.equal(verification.firstDivergence, 2);
  });

  test('verification is skipped when states grow beyond the verify limit', () => {
    const rules: Rule[] = [{ id: 'dup', lhs: 'a', rhs: 'aa' }];
    const trace = rewrite(rules, 'a', { maxSteps: 20, verifyMaxLength: 10 });
    assert.equal(trace.outcome.kind, 'budget-exhausted');
    if (trace.outcome.kind !== 'budget-exhausted') return;
    assert.equal(trace.outcome.verification.checked, false);
    assert.equal(typeof trace.outcome.verification.reason, 'string');
  });
});

describe('short-string interpreter', () => {
  test('reproduces the same state sequence independently', () => {
    const rules: Rule[] = [
      { id: 'grow', lhs: 'ab', rhs: 'bba' },
      { id: 'shrink', lhs: 'bb', rhs: 'b' },
    ];
    const result = interpret(rules, 'ab', { maxSteps: 10 });
    assert.equal(result.halted, true);
    assert.deepEqual(result.states, ['ab', 'bba', 'ba']);
  });

  test('reports not halted when the step budget runs out', () => {
    const result = interpret([{ id: 'dup', lhs: 'a', rhs: 'aa' }], 'a', { maxSteps: 4 });
    assert.equal(result.halted, false);
    assert.deepEqual(result.states, ['a', 'aa', 'aaa', 'aaaa', 'aaaaa']);
  });
});

describe('validation and determinism', () => {
  test('rejects empty lhs and duplicate ids', () => {
    assert.throws(() => rewrite([{ id: 'bad', lhs: '', rhs: 'x' }], 'a'));
    assert.throws(() =>
      rewrite(
        [
          { id: 'r', lhs: 'a', rhs: 'b' },
          { id: 'r', lhs: 'b', rhs: 'c' },
        ],
        'a',
      ),
    );
  });

  test('rewriting is deterministic across runs', () => {
    const rules: Rule[] = [
      { id: 'grow', lhs: 'ab', rhs: 'bba' },
      { id: 'shrink', lhs: 'bb', rhs: 'b' },
      { id: 'swap', lhs: 'ba', rhs: 'ab' },
    ];
    assert.deepEqual(rewrite(rules, 'abba'), rewrite(rules, 'abba'));
  });

  test('empty input closes immediately', () => {
    const trace = rewrite([{ id: 'r', lhs: 'a', rhs: 'b' }], '');
    assert.equal(trace.outcome.kind, 'normal-form');
    assert.equal(trace.steps.length, 0);
    assert.equal(trace.final, '');
  });
});
