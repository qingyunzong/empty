import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RetryBudget, RetryBudgetRegistry } from './index.js';

const transient = () => Object.assign(new Error('boom'), { status: 503 });
const cancelled = () => Object.assign(new Error('aborted'), { name: 'AbortError' });

test('workflow-level budget is shared across task instances', () => {
  const registry = new RetryBudgetRegistry();
  registry.setWorkflowBudget('wf-1', 2);

  const a = registry.resolve({ workflowId: 'wf-1', family: 'extract', instanceId: 'i-1' });
  const b = registry.resolve({ workflowId: 'wf-1', family: 'load', instanceId: 'i-2' });

  assert.equal(a.budget.remaining, 2);
  const d1 = a.budget.recordFailure(transient());
  assert.equal(d1.allowed, true);
  assert.equal(d1.remaining, 1);
  assert.equal(b.budget.remaining, 1, 'second instance sees the shared deduction');
});

test('resolution falls through instance -> family -> workflow', () => {
  const registry = new RetryBudgetRegistry();
  registry.setWorkflowBudget('wf-1', 5);
  registry.setFamilyBudget('wf-1', 'extract', 3);
  registry.setInstanceBudget('wf-1', 'extract', 'i-9', 1);

  const instance = registry.resolve({ workflowId: 'wf-1', family: 'extract', instanceId: 'i-9' });
  assert.equal(instance.budget.scope, 'instance');
  assert.equal(instance.budget.limit, 1);

  const family = registry.resolve({ workflowId: 'wf-1', family: 'extract', instanceId: 'i-1' });
  assert.equal(family.budget.scope, 'family');
  assert.equal(family.budget.limit, 3);

  const workflow = registry.resolve({ workflowId: 'wf-1', family: 'load' });
  assert.equal(workflow.budget.scope, 'workflow');
  assert.equal(workflow.budget.limit, 5);

  assert.ok(
    family.evidence.some((e) => e.outcome.includes('falling through')),
    'evidence records the fall-through chain',
  );
});

test('cancellation does not consume budget and is not retryable', () => {
  const budget = RetryBudget.create({ scope: 'instance', name: 't-1', limit: 1 });
  const decision = budget.recordFailure(cancelled());

  assert.equal(decision.allowed, false);
  assert.equal(decision.consumed, false);
  assert.equal(decision.remaining, 1);
  assert.equal(decision.category, 'cancelled');
});

test('permanent errors are not retried and do not consume budget', () => {
  const budget = RetryBudget.create({ scope: 'instance', name: 't-1', limit: 1 });
  const decision = budget.recordFailure(Object.assign(new Error('bad'), { status: 422 }));

  assert.equal(decision.allowed, false);
  assert.equal(decision.consumed, false);
  assert.equal(decision.remaining, 1);
  assert.equal(decision.category, 'permanent');
});

test('concurrent failures deduct atomically; last slot granted exactly once', () => {
  const budget = RetryBudget.create({ scope: 'workflow', name: 'wf-1', limit: 1 });

  const decisions = Array.from({ length: 8 }, () => budget.recordFailure(transient()));
  const granted = decisions.filter((d) => d.allowed && d.consumed);

  assert.equal(granted.length, 1, 'exactly one failure wins the final slot');
  assert.equal(budget.remaining, 0);
  assert.ok(decisions.slice(1).every((d) => !d.allowed && !d.consumed));
});

test('subtask forks inherit the same parent budget', () => {
  const parent = RetryBudget.create({ scope: 'family', name: 'wf-1/extract', limit: 2 });
  const childA = parent.fork('shard-0');
  const childB = parent.fork('shard-1');

  childA.recordFailure(transient());
  const decision = childB.recordFailure(transient());

  assert.equal(parent.remaining, 0, 'children spend from the parent pool');
  assert.equal(decision.remaining, 0);
  assert.equal(childB.recordFailure(transient()).allowed, false);
  assert.ok(
    decision.evidence[0].outcome.includes('subtask:shard-1'),
    'evidence carries the fork lineage',
  );
});

test('every decision returns remaining and rule evidence', () => {
  const budget = RetryBudget.create({ scope: 'workflow', name: 'wf-1', limit: 1 });

  const first = budget.recordFailure(transient());
  assert.equal(first.remaining, 0);
  assert.ok(first.evidence.length >= 3);
  assert.ok(first.evidence.some((e) => e.rule === 'consume:true'));

  const second = budget.recordFailure(transient());
  assert.equal(second.remaining, 0);
  assert.ok(second.evidence.some((e) => e.rule === 'budget-exhausted'));
});

test('custom classifier decides consumption per error category', () => {
  const budget = RetryBudget.create({
    scope: 'instance',
    name: 't-1',
    limit: 1,
    classifier: (error) =>
      error instanceof Error && error.message === 'skip'
        ? { category: 'ignored', consumesBudget: false, retryable: true, reason: 'test rule' }
        : { category: 'transient', consumesBudget: true, retryable: true, reason: 'test rule' },
  });

  const skipped = budget.recordFailure(new Error('skip'));
  assert.equal(skipped.allowed, true);
  assert.equal(skipped.consumed, false);
  assert.equal(skipped.remaining, 1);

  const spent = budget.recordFailure(new Error('real'));
  assert.equal(spent.consumed, true);
  assert.equal(spent.remaining, 0);
});

test('invalid limits are rejected', () => {
  assert.throws(() => RetryBudget.create({ scope: 'workflow', name: 'wf', limit: -1 }), RangeError);
  assert.throws(() => RetryBudget.create({ scope: 'workflow', name: 'wf', limit: 1.5 }), RangeError);
});

test('resolve throws when no budget exists at any level', () => {
  const registry = new RetryBudgetRegistry();
  assert.throws(() => registry.resolve({ workflowId: 'missing' }), /no retry budget/);
});
