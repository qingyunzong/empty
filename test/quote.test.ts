import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCommand, parseCommand, quoteArg } from '../src/index.js';

test('round-trip: empty string, single quotes, newlines', () => {
  const cases = [
    '',
    "'",
    "''",
    "'''",
    '\n',
    '\n\n',
    'a\nb\nc',
    "it's",
    "don't stop",
    ' \t ',
    'a b',
    '"double"',
    'back\\slash',
    '$HOME `whoami` !bang *glob? [br] {br} ~tilde #hash',
    "mix'of\nevery thing\\else$",
  ];
  for (const value of cases) {
    assert.deepEqual(parseCommand(buildCommand([value])), [value], JSON.stringify(value));
  }
});

test('round-trip: multiple arguments keep count and values', () => {
  const args = ['', 'a', "x'y", 'line1\nline2', '', 'plain'];
  assert.deepEqual(parseCommand(buildCommand(args)), args);
});

test('NUL bytes are forbidden', () => {
  assert.throws(() => quoteArg('a\0b'), /NUL/);
  assert.throws(() => buildCommand(['ok', 'bad\0']), /NUL/);
  assert.throws(() => parseCommand('a\0b'), /NUL/);
});

test('decoder is independent: no expansion, malformed input rejected', () => {
  assert.deepEqual(parseCommand(`'$HOME' "\\$x" ` + '\\`echo\\`'), ['$HOME', '$x', '`echo`']);
  assert.throws(() => parseCommand("'unterminated"), /unterminated single/);
  assert.throws(() => parseCommand('"unterminated'), /unterminated double/);
  assert.throws(() => parseCommand('dangling\\'), /dangling backslash/);
  assert.deepEqual(parseCommand('a\\\nb'), ['ab']); // line continuation
});

function* strings(alphabet: string[], maxLen: number): Generator<string> {
  yield '';
  if (maxLen === 0) return;
  for (const rest of strings(alphabet, maxLen - 1)) {
    for (const c of alphabet) yield c + rest;
  }
}

test('exhaustive round-trip over short tricky character set (len <= 3)', () => {
  const alphabet = ['a', '0', "'", '"', '\\', ' ', '\t', '\n', '$', '`', '!', '*', '~', '#', '@', '%'];
  let count = 0;
  for (const s of strings(alphabet, 3)) {
    assert.deepEqual(parseCommand(buildCommand([s])), [s], JSON.stringify(s));
    count++;
  }
  assert.equal(count, 1 + 16 + 256 + 4096);
});

test('exhaustive: concatenation never changes argument count (all pairs, len <= 2)', () => {
  const alphabet = ['a', "'", '"', '\\', ' ', '\n', '$', '`'];
  const pool = [...strings(alphabet, 2)]; // 1 + 8 + 64 = 73 strings
  let count = 0;
  for (const a of pool) {
    for (const b of pool) {
      const parsed = parseCommand(buildCommand([a, b]));
      assert.equal(parsed.length, 2, `count changed for ${JSON.stringify([a, b])}`);
      assert.deepEqual(parsed, [a, b]);
      count++;
    }
  }
  assert.equal(count, 73 * 73);
});

test('exhaustive: all triples over minimal tricky set keep count 3', () => {
  const pool = [...strings(['a', "'", ' ', '\n'], 2)]; // 21 strings
  let count = 0;
  for (const a of pool) for (const b of pool) for (const c of pool) {
    const parsed = parseCommand(buildCommand([a, b, c]));
    assert.equal(parsed.length, 3);
    assert.deepEqual(parsed, [a, b, c]);
    count++;
  }
  assert.equal(count, 21 ** 3);
});
