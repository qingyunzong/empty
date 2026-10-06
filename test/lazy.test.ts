import test from 'node:test';
import assert from 'node:assert/strict';
import { add, div, letIn, lit, mul, sub, variable, type Expr } from '../src/expr.js';
import { LazyEvaluator, type EvalResult } from '../src/lazy.js';
import {
  BlackHoleError,
  BudgetExhaustedError,
  DivisionByZeroError,
  UnboundVariableError,
} from '../src/errors.js';
import { interpret } from '../src/interp.js';

const valueOf = (result: EvalResult): number => {
  assert.ok(result.ok, 'expected success');
  return result.value;
};

const errorOf = (result: EvalResult) => {
  assert.ok(!result.ok, 'expected failure');
  return result.error;
};

test('evaluates integer arithmetic', () => {
  const ev = new LazyEvaluator();
  assert.equal(valueOf(ev.run(add(lit(2), mul(lit(3), lit(4))))), 14);
  assert.equal(valueOf(ev.run(sub(lit(7), lit(10)))), -3);
  assert.equal(valueOf(ev.run(div(lit(7), lit(2)))), 3); // truncating division
  assert.equal(valueOf(ev.run(div(lit(-7), lit(2)))), -3);
});

test('let bindings are shared: bound expression evaluated at most once', () => {
  const ev = new LazyEvaluator();
  const result = ev.run(letIn('x', add(lit(1), lit(1)), add(variable('x'), variable('x'))));
  assert.equal(valueOf(result), 4);
  assert.equal(ev.trace.filter((label) => label === 'x').length, 1);
});

test('let bindings are lazy: unused failing bindings are never evaluated', () => {
  const ev = new LazyEvaluator();
  const result = ev.run(letIn('boom', div(lit(1), lit(0)), lit(42)));
  assert.equal(valueOf(result), 42);
  assert.ok(!ev.trace.includes('boom'));
});

test('self-dependency reports a black hole, cached with the identical diagnostic', () => {
  for (const expr of [
    letIn('x', variable('x'), variable('x')),
    letIn('x', add(variable('x'), lit(1)), variable('x')),
  ]) {
    const ev = new LazyEvaluator();
    const thunk = ev.compile(expr);
    const first = errorOf(ev.force(thunk));
    const second = errorOf(ev.force(thunk));
    assert.ok(first instanceof BlackHoleError);
    assert.match(first.message, /black hole/);
    assert.strictEqual(first, second); // same cached diagnostic object
    assert.equal(ev.trace.filter((label) => label === 'x').length, 1); // evaluated once
  }
});

test('failure caching replays the identical diagnostic object', () => {
  const ev = new LazyEvaluator();
  const thunk = ev.compile(div(lit(1), lit(0)));
  const first = errorOf(ev.force(thunk));
  const afterFirst = ev.evaluations;
  const second = errorOf(ev.force(thunk));
  assert.ok(first instanceof DivisionByZeroError);
  assert.strictEqual(first, second);
  assert.equal(ev.evaluations, afterFirst); // second force served from cache
});

test('a shared failing binding is evaluated once and fails every use identically', () => {
  const ev = new LazyEvaluator();
  const thunk = ev.compile(letIn('x', div(lit(1), lit(0)), add(variable('x'), variable('x'))));
  const error = errorOf(ev.force(thunk));
  assert.ok(error instanceof DivisionByZeroError);
  assert.equal(ev.trace.filter((label) => label === 'x').length, 1);
});

test('unbound variables fail with a stable diagnostic', () => {
  const ev = new LazyEvaluator();
  const thunk = ev.compile(variable('nope'));
  const first = errorOf(ev.force(thunk));
  assert.ok(first instanceof UnboundVariableError);
  assert.equal(first.message, 'unbound variable: nope');
  assert.strictEqual(first, errorOf(ev.force(thunk)));
});

test('forcing order is observable via the trace', () => {
  const ev = new LazyEvaluator();
  const expr = letIn('a', lit(1), letIn('b', lit(2), add(variable('a'), variable('b'))));
  assert.equal(valueOf(ev.run(expr)), 3);
  assert.deepStrictEqual(ev.trace, ['let a', 'let b', 'add', 'a', 'lit(1)', 'b', 'lit(2)']);
});

test('budget is charged only for actually evaluated nodes', () => {
  // Demand path evaluates exactly 4 nodes; y and lit(2) are never touched.
  const expr = letIn('x', lit(1), letIn('y', lit(2), variable('x')));
  const ev = new LazyEvaluator({ budget: 4 });
  assert.equal(valueOf(ev.run(expr)), 1);
  assert.equal(ev.evaluations, 4);
  assert.equal(ev.remainingBudget, 0);
  assert.ok(!ev.trace.includes('y'));

  const short = new LazyEvaluator({ budget: 3 });
  const error = errorOf(short.run(expr));
  assert.ok(error instanceof BudgetExhaustedError);
});

test('cache hits are free: re-forcing needs no budget', () => {
  const expr = letIn('x', add(lit(1), lit(1)), add(variable('x'), variable('x')));
  const ev = new LazyEvaluator({ budget: 6 });
  const thunk = ev.compile(expr);
  assert.equal(valueOf(ev.force(thunk)), 4);
  assert.equal(ev.remainingBudget, 0);
  assert.equal(valueOf(ev.force(thunk)), 4); // fully cached, zero budget left
  assert.equal(ev.evaluations, 6);
});

test('budget exhaustion is not cached: evaluation resumes after topping up', () => {
  const expr = letIn('x', lit(1), add(variable('x'), variable('x')));
  const ev = new LazyEvaluator({ budget: 2 });
  const thunk = ev.compile(expr);
  assert.ok(errorOf(ev.force(thunk)) instanceof BudgetExhaustedError);
  ev.addBudget(4);
  assert.equal(valueOf(ev.force(thunk)), 2);
});
