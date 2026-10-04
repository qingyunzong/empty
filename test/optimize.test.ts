import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, print, evaluate, optimize } from '../src/index.js';

function roundtrip(src: string) {
  const parsed = parse(src);
  const before = evaluate(parsed);
  const { expr, rewrites } = optimize(parsed);
  return { before, after: evaluate(expr), printed: print(expr), rewrites };
}

test('constant folding preserves division-by-zero error', () => {
  const { before, after, printed, rewrites } = roundtrip('((8 / 2) + (1 / 0))');
  assert.equal(printed, '(4 + (1 / 0))');
  assert.equal(before.error?.message, 'integer division by zero');
  assert.equal(after.error?.message, 'integer division by zero');
  assert.ok(rewrites.some((r) => r.rule === 'const-fold'));
});

test('log action order is preserved', () => {
  const { before, after } = roundtrip('((log(1) + log(2)) * (log(3) + 0))');
  assert.deepEqual(before.log, [1, 2, 3]);
  assert.deepEqual(after.log, [1, 2, 3]);
  assert.equal(after.value, before.value);
});

test('cse shares a pure must-execute subexpression', () => {
  const { printed, rewrites, before, after } = roundtrip('let a = 3 in ((a + 1) * (a + 1))');
  assert.equal(printed, 'let a = 3 in let $cse0 = (a + 1) in ($cse0 * $cse0)');
  const cse = rewrites.filter((r) => r.rule === 'cse');
  assert.equal(cse.length, 2);
  assert.equal(after.value, before.value);
});

test('cse never shares impure subexpressions', () => {
  const { printed, rewrites, before, after } = roundtrip('let a = 3 in ((log(a) + 1) * (log(a) + 1))');
  assert.ok(!printed.includes('$cse'));
  assert.ok(!rewrites.some((r) => r.rule === 'cse'));
  assert.deepEqual(after.log, before.log);
});

test('cse never shares expressions under if branches', () => {
  const { printed } = roundtrip('let a = 3 in if (a, (a + 1), (a + 1))');
  assert.ok(!printed.includes('$cse'));
});

test('cse does not hoist a raising expression past a possible error', () => {
  const { printed } = roundtrip('let a = 3 in ((1 / a) + ((10 / a) * (10 / a)))');
  assert.ok(!printed.includes('$cse'));
});

test('cse shares a raising expression when nothing before it can interfere', () => {
  const src = 'let a = 3 in (((10 / a) * (10 / a)) + (1 / a))';
  const { before, after, printed } = roundtrip(src);
  assert.ok(printed.includes('$cse0'));
  assert.equal(after.value, before.value);
  assert.equal(after.error, null);
});

test('cse hoists a pure non-raising expression past log actions', () => {
  const { before, after, printed } = roundtrip('let a = 3 in (log(a) + ((a + 1) * (a + 1)))');
  assert.ok(printed.includes('$cse0'));
  assert.deepEqual(after.log, before.log);
});

test('x * 0 keeps side effects but drops pure non-raising operands', () => {
  const withLog = roundtrip('let a = 3 in (log(a) * 0)');
  assert.ok(withLog.printed.includes('log'));
  assert.deepEqual(withLog.after.log, [3]);

  const pure = roundtrip('let a = 3 in ((a + 1) * 0)');
  assert.equal(pure.printed, 'let a = 3 in 0');
  assert.equal(pure.after.value, 0);
});

test('x * 0 keeps a raising operand', () => {
  const src = 'let a = 0 in ((10 / a) * 0)';
  const { before, after, printed } = roundtrip(src);
  assert.ok(printed.includes('(10 / a)'));
  assert.equal(before.error?.message, 'integer division by zero');
  assert.equal(after.error?.message, 'integer division by zero');
});

test('dead branch elimination removes only the untaken branch', () => {
  const { after, printed } = roundtrip('if (0, log(1), 42)');
  assert.equal(printed, '42');
  assert.equal(after.value, 42);
  assert.deepEqual(after.log, []);
});

test('every rewrite maps before/after spans into the source', () => {
  const src = 'let a = 3 in (log(a) + ((a + 1) * (a + 1)))';
  const { rewrites } = roundtrip(src);
  assert.ok(rewrites.length > 0);
  for (const rw of rewrites) {
    for (const span of [rw.before, rw.after]) {
      assert.ok(span.start >= 0 && span.start < span.end && span.end <= src.length,
        `span out of range: ${JSON.stringify(span)}`);
    }
    assert.equal(src.slice(rw.before.start, rw.before.end), 'a + 1');
  }
});
