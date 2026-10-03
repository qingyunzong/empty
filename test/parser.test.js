import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseExpression, evaluate, collectRefs } from '../src/parser.js';
import { PlanError } from '../src/errors.js';

test('pratt parser respects precedence: | looser than &', () => {
  assert.deepEqual(parseExpression('a | b & c'), {
    kind: 'or',
    left: { kind: 'ref', name: 'a' },
    right: {
      kind: 'and',
      left: { kind: 'ref', name: 'b' },
      right: { kind: 'ref', name: 'c' },
    },
  });
});

test('pratt parser: ! binds tightest', () => {
  assert.deepEqual(parseExpression('!a & b'), {
    kind: 'and',
    left: { kind: 'not', operand: { kind: 'ref', name: 'a' } },
    right: { kind: 'ref', name: 'b' },
  });
});

test('pratt parser: parentheses override precedence', () => {
  assert.deepEqual(parseExpression('(a | b) & c'), {
    kind: 'and',
    left: {
      kind: 'or',
      left: { kind: 'ref', name: 'a' },
      right: { kind: 'ref', name: 'b' },
    },
    right: { kind: 'ref', name: 'c' },
  });
});

test('pratt parser: & and | are left-associative', () => {
  const ast = parseExpression('a & b & c');
  assert.equal(ast.kind, 'and');
  assert.equal(ast.left.kind, 'and');
  assert.deepEqual(ast.right, { kind: 'ref', name: 'c' });
});

test('parser rejects malformed expressions', () => {
  for (const bad of ['', 'a &', '& a', '(a', 'a b', 'a && b', 'a @ b', '!)']) {
    assert.throws(() => parseExpression(bad), PlanError, JSON.stringify(bad));
  }
});

test('evaluate and collectRefs over a set of active tasks', () => {
  const ast = parseExpression('(fetch | synth) & !skip');
  assert.deepEqual([...collectRefs(ast)].sort(), ['fetch', 'skip', 'synth']);
  const has = (set) => (name) => set.has(name);
  assert.equal(evaluate(ast, has(new Set(['fetch']))), true);
  assert.equal(evaluate(ast, has(new Set(['synth', 'skip']))), false);
  assert.equal(evaluate(ast, has(new Set(['clean'])), ), false);
});
