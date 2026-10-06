import test from 'node:test';
import assert from 'node:assert/strict';
import { add, div, letIn, lit, mul, sub, variable, type Expr } from '../src/expr.js';
import { LazyEvaluator, type EvalResult } from '../src/lazy.js';
import type { EvalError } from '../src/errors.js';
import { interpret } from '../src/interp.js';

const mulberry32 = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** Random expression generator. Bound names are excluded from their own
 *  definition's scope, so generated programs never self-reference. */
function genExpr(rng: () => number, scope: readonly string[], depth: number, fresh: () => string): Expr {
  const pick = rng();
  if (depth <= 0 || pick < 0.3) {
    if (scope.length > 0 && rng() < 0.6) {
      return variable(scope[Math.floor(rng() * scope.length)]!);
    }
    if (rng() < 0.1) return variable('free'); // occasionally unbound
    return lit(Math.floor(rng() * 21) - 10);
  }
  if (pick < 0.75) {
    const ops = [add, sub, mul, div] as const;
    const op = ops[Math.floor(rng() * ops.length)]!;
    return op(genExpr(rng, scope, depth - 1, fresh), genExpr(rng, scope, depth - 1, fresh));
  }
  const name = fresh();
  const value = genExpr(rng, scope, depth - 1, fresh);
  const body = genExpr(rng, [...scope, name], depth - 1, fresh);
  return letIn(name, value, body);
}

const runInterpreter = (expr: Expr): EvalResult => {
  try {
    return { ok: true, value: interpret(expr) };
  } catch (error) {
    return { ok: false, error: error as EvalError };
  }
};

test('shared lazy evaluator agrees with the non-sharing interpreter', () => {
  const rng = mulberry32(0x5eed);
  let counter = 0;
  const fresh = () => `v${counter++}`;
  let successes = 0;
  let failures = 0;

  for (let i = 0; i < 500; i += 1) {
    const expr = genExpr(rng, [], 4, fresh);
    const shared = new LazyEvaluator().run(expr);
    const reference = runInterpreter(expr);

    assert.equal(shared.ok, reference.ok, `outcome mismatch on case ${i}`);
    if (shared.ok && reference.ok) {
      assert.equal(shared.value, reference.value, `value mismatch on case ${i}`);
      successes += 1;
    } else if (!shared.ok && !reference.ok) {
      assert.equal(shared.error.message, reference.error.message, `diagnostic mismatch on case ${i}`);
      failures += 1;
    }
  }

  assert.ok(successes > 100, `expected plenty of successes, got ${successes}`);
  assert.ok(failures > 20, `expected some failures, got ${failures}`);
});

test('sharing does not change results under repeated use of one binding', () => {
  // x is demanded three times; the non-sharing interpreter evaluates it
  // three times, the shared evaluator once — results must still agree.
  const expr = letIn(
    'x',
    add(mul(lit(3), lit(4)), lit(1)),
    add(variable('x'), add(variable('x'), variable('x'))),
  );
  const shared = new LazyEvaluator();
  const result = shared.run(expr);
  assert.ok(result.ok);
  assert.equal(result.value, interpret(expr));
  assert.equal(shared.trace.filter((label) => label === 'x').length, 1);
});
