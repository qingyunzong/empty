import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EvalError, evaluate, parse } from '../src/index.ts';

test('host-provided variables', () => {
  assert.equal(evaluate('x + y', { vars: { x: 1n, y: 2n } }), 3n);
  assert.equal(evaluate('flag ? 1 : 2', { vars: { flag: true } }), 1n);
});

test('missing variable error carries the source range', () => {
  let caught: unknown;
  try {
    evaluate('1 + nope * 2');
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof EvalError);
  assert.match(caught.message, /Unknown variable 'nope'/);
  assert.match(caught.message, /line 1, column 5/);
  assert.deepEqual(caught.span, { start: 4, end: 8 });
  assert.equal(caught.range.startLine, 1);
  assert.equal(caught.range.startCol, 5);
  assert.equal(caught.range.endLine, 1);
  assert.equal(caught.range.endCol, 9);
});

test('missing variable range tracks lines and columns', () => {
  let caught: unknown;
  try {
    evaluate('1 + 2\n  + missing');
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof EvalError);
  assert.equal(caught.range.startLine, 2);
  assert.equal(caught.range.startCol, 5);
});

test('parsing is separated from execution: one parse, many evaluations', () => {
  const program = parse('x * 2');
  assert.equal(evaluate(program, { vars: { x: 3n } }), 6n);
  assert.equal(evaluate(program, { vars: { x: 21n } }), 42n);
});

test('lazy host variables are not fetched when unused', () => {
  let calls = 0;
  const value = evaluate('1', {
    vars: {
      unused: () => {
        calls++;
        return 0n;
      },
    },
  });
  assert.equal(value, 1n);
  assert.equal(calls, 0);
});

test('lazy host variables are fetched at most once', () => {
  let calls = 0;
  const value = evaluate('x + x', {
    vars: {
      x: () => {
        calls++;
        return 5n;
      },
    },
  });
  assert.equal(value, 10n);
  assert.equal(calls, 1);
});
