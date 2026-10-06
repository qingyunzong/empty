import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSelector, SelectorSyntaxError } from '../src/index.js';

test('parses a bare tag', () => {
  const selector = parseSelector('div');
  assert.equal(selector.chains.length, 1);
  assert.equal(selector.chains[0]!.first.tag, 'div');
  assert.equal(selector.chains[0]!.rest.length, 0);
});

test('parses tag with attribute equality, quoted and bare', () => {
  const quoted = parseSelector('a[href="/x"]');
  assert.deepEqual(quoted.chains[0]!.first.attrs, [{ name: 'href', value: '/x' }]);
  const bare = parseSelector('a[data-n=2]');
  assert.deepEqual(bare.chains[0]!.first.attrs, [{ name: 'data-n', value: '2' }]);
  const single = parseSelector("a[href='/y z']");
  assert.deepEqual(single.chains[0]!.first.attrs, [{ name: 'href', value: '/y z' }]);
});

test('parses universal selector and multiple attributes', () => {
  const selector = parseSelector('*[a="1"][b="2"]');
  assert.equal(selector.chains[0]!.first.tag, null);
  assert.equal(selector.chains[0]!.first.attrs.length, 2);
});

test('parses child and descendant combinators', () => {
  const selector = parseSelector('div > p span');
  const chain = selector.chains[0]!;
  assert.equal(chain.rest.length, 2);
  assert.equal(chain.rest[0]!.combinator, 'child');
  assert.equal(chain.rest[1]!.combinator, 'descendant');
});

test('parses comma unions', () => {
  const selector = parseSelector('div, span > a , [data-x="1"]');
  assert.equal(selector.chains.length, 3);
  assert.equal(selector.chains[2]!.first.tag, null);
});

function errorOf(input: string): SelectorSyntaxError {
  try {
    parseSelector(input);
  } catch (error) {
    if (error instanceof SelectorSyntaxError) return error;
    throw new Error(`expected SelectorSyntaxError for ${input}`);
  }
  throw new Error(`expected parse to fail for ${input}`);
}

test('reports character ranges for errors', () => {
  assert.deepEqual(
    (({ start, end }) => ({ start, end }))(errorOf('')),
    { start: 0, end: 0 },
  );

  const trailingChild = errorOf('div > ');
  assert.deepEqual({ start: trailingChild.start, end: trailingChild.end }, { start: 6, end: 6 });

  const badAttr = errorOf('div [="1"]');
  assert.deepEqual({ start: badAttr.start, end: badAttr.end }, { start: 5, end: 6 });

  const missingBracket = errorOf('a[x="1"');
  assert.equal(missingBracket.start, 1);
  assert.equal(missingBracket.end, 7);

  const doubleComma = errorOf('a,,b');
  assert.deepEqual({ start: doubleComma.start, end: doubleComma.end }, { start: 2, end: 3 });

  const trailingComma = errorOf('a, ');
  assert.equal(trailingComma.start, 3);

  const unterminated = errorOf('a[x="abc');
  assert.equal(unterminated.start, 5);
  assert.equal(unterminated.end, 8);

  const missingEquals = errorOf('a[x"1"]');
  assert.equal(missingEquals.start, 3);
});

test('error ranges point into the original input', () => {
  const input = 'ul li > [data-x=]';
  const error = errorOf(input);
  assert.ok(error.start >= 0 && error.end <= input.length);
  assert.match(error.message, /at \d+\.\.\d+/);
});
