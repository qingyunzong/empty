import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.ts';
import { ParseError } from '../src/errors.ts';

test('precedence: multiplication binds tighter than addition', () => {
  const node = parse('2 + 3 * 4');
  assert.equal(node.kind, 'bin');
  assert.equal((node as { op: string }).op, '+');
});

test('power is right associative: 2 ^ 3 ^ 2', () => {
  const node = parse('2 ^ 3 ^ 2');
  assert.equal(node.kind, 'bin');
  const bin = node as { op: string; right: { kind: string; op?: string } };
  assert.equal(bin.op, '^');
  assert.equal(bin.right.kind, 'bin');
  assert.equal(bin.right.op, '^');
});

test('unary minus binds looser than power: -2^2 is -(2^2)', () => {
  const node = parse('-2 ^ 2');
  assert.equal(node.kind, 'neg');
});

test('every node carries a source range', () => {
  const source = '12 + 345 * 6';
  const node = parse(source);
  assert.equal(source.slice(node.range.start, node.range.end), source);
  const bin = node as { left: { range: { start: number; end: number } } };
  assert.equal(source.slice(bin.left.range.start, bin.left.range.end), '12');
});

test('parenthesized node range covers the parentheses', () => {
  const source = '(1 + 2) * 3';
  const node = parse(source);
  const bin = node as { left: { range: { start: number; end: number } } };
  assert.equal(source.slice(bin.left.range.start, bin.left.range.end), '(1 + 2)');
});

test('parse errors carry an offset', () => {
  assert.throws(
    () => parse('1 + @'),
    (error: unknown) => error instanceof ParseError && (error as ParseError).offset === 4,
  );
  assert.throws(() => parse('1 +'), ParseError);
  assert.throws(() => parse('1 2'), ParseError);
});
