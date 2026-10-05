import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Env,
  EvalError,
  Machine,
  parse,
} from '../src/index.js';

test('undefined variable error carries the source range', () => {
  const src = '10 + missing * 2';
  let caught: unknown;
  try {
    new Machine(parse(src)).run();
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof EvalError);
  const err = caught as EvalError;
  assert.deepEqual(err.span, { start: 5, end: 12 });
  assert.equal(src.slice(err.span!.start, err.span!.end), 'missing');
  assert.match(err.message, /undefined variable 'missing'/);
  assert.match(err.message, /line 1, column 6/);
});

test('undefined variable position tracks lines', () => {
  let caught: unknown;
  try {
    new Machine(parse('1 +\n  nope')).run();
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof EvalError);
  assert.match((caught as Error).message, /line 2, column 3/);
});

test('pause and resume matches a single uninterrupted run', () => {
  const src = 'fn fact(n) { n <= 1 ? 1 : n * fact(n - 1) } fact(25)';
  const expected = new Machine(parse(src)).run();
  for (const pauseAfter of [1, 2, 5, 17, 100]) {
    const m = new Machine(parse(src));
    for (let i = 0; i < pauseAfter && !m.done; i++) m.step();
    const snapshot = m.pause();
    const restored = Machine.restore(snapshot);
    assert.equal(restored.run(), expected);
    assert.equal(m.run(), expected);
  }
});

test('pausing at every single step still matches one run', () => {
  const src = 'fn fib(n) { n < 2 ? n : fib(n - 1) + fib(n - 2) } fib(12)';
  const expected = new Machine(parse(src)).run();
  const m = new Machine(parse(src));
  while (!m.done) {
    m.step();
    const snapshot = m.pause();
    const probe = Machine.restore(snapshot);
    if (!probe.done) {
      probe.step();
    }
  }
  assert.equal(m.run(), expected);
});

test('checking an unevaluated argument produces no error', () => {
  const m = new Machine(parse('fn f(x, y) { y } f(1 / 0, 7)'));
  assert.equal(m.run(), 7n);
  const thunk = m.thunks[0];
  assert.equal(thunk.state, 'pending');
  assert.equal(thunk.value, null);
  assert.equal(thunk.error, null);
  assert.equal(m.thunks[1].state, 'value');
  assert.equal(m.stats.thunkForces, 1);
});

test('a cached failure is rethrown without re-evaluating', () => {
  const m1 = new Machine(parse('fn f(x) { x } f(1 / 0)'));
  assert.throws(() => m1.run(), /division by zero/);
  assert.equal(m1.stats.thunkForces, 1);
  const thunk = m1.thunks[0];
  assert.equal(thunk.state, 'error');
  const cached = thunk.error;
  assert.ok(cached instanceof EvalError);

  const env = new Env();
  env.define('x', thunk);
  const m2 = new Machine(
    { decls: [], body: { kind: 'var', name: 'x', span: { start: 0, end: 1 } } },
    { env },
  );
  assert.throws(
    () => m2.run(),
    (e: unknown) => e === cached,
  );
  assert.equal(m2.stats.thunkForces, 0);
});

test('nested lazy arguments each cache the same failure', () => {
  const m = new Machine(parse('fn f(x) { x } fn g(y) { f(y) } g(1 / 0)'));
  assert.throws(() => m.run(), /division by zero/);
  assert.equal(m.thunks.length, 2);
  assert.equal(m.thunks[0].state, 'error');
  assert.equal(m.thunks[1].state, 'error');
  assert.equal(m.stats.thunkForces, 2);
});
