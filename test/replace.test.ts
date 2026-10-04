import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { findMatches } from '../src/match';
import { replace, BudgetExceededError } from '../src/replace';
import { parseTemplate, InvalidReferenceError } from '../src/template';
import type { CaptureMatch } from '../src/types';

test('basic replacement with capture and output->source mapping', () => {
  const text = 'hello world';
  const matches: CaptureMatch[] = [{ start: 6, end: 11, captures: [{ start: 6, end: 11 }] }];
  const { output, map } = replace(text, matches, ['<$1>']);
  assert.equal(output, 'hello <world>');
  assert.equal(map.inLength, 11);
  assert.equal(map.outLength, 13);
  assert.equal(map.forward(5), 5); // copied gap
  assert.equal(map.forward(6), null); // inserted '<'
  assert.equal(map.forward(7), 6); // 'w' copied from source 6
  assert.equal(map.forward(11), 10);
  assert.equal(map.forward(12), null); // inserted '>'
  assert.deepEqual(map.inverse(6), [{ start: 7, end: 8 }]);
  assert.deepEqual(map.inverse(5), [{ start: 5, end: 6 }]);
});

test('inserted content has no source; zero-length match inserts in place', () => {
  const { output, map } = replace('ab', [{ start: 1, end: 1, captures: [] }], ['-']);
  assert.equal(output, 'a-b');
  assert.equal(map.forward(0), 0);
  assert.equal(map.forward(1), null);
  assert.equal(map.forward(2), 1);
  assert.deepEqual(map.inverse(1), [{ start: 2, end: 3 }]);
});

test('duplicated capture gives one source many outputs', () => {
  const { output, map } = replace('ab', [{ start: 0, end: 2, captures: [{ start: 0, end: 1 }] }], [
    '$1-$1',
  ]);
  assert.equal(output, 'a-a');
  assert.deepEqual(map.inverse(0), [
    { start: 0, end: 1 },
    { start: 2, end: 3 },
  ]);
  assert.equal(map.forward(1), null); // '-'
});

test('template syntax: $$, $&, trailing $, literal $x, two-digit groups', () => {
  const m: CaptureMatch = { start: 0, end: 2, captures: [] };
  assert.equal(replace('xy', [m], ['[$&]$$']).output, '[xy]$');
  assert.equal(replace('xy', [m], ['$x']).output, '$x');
  assert.equal(replace('xy', [m], ['a$']).output, 'a$');
  const captures = Array.from({ length: 12 }, (_, i) => ({ start: 0, end: 1 }));
  const m12: CaptureMatch = { start: 0, end: 2, captures };
  assert.equal(replace('ab', [m12], ['$12']).output, 'a'); // group 12
  assert.equal(replace('ab', [m12], ['$13']).output, 'a3'); // group 1 + literal '3'
});

test('non-participating capture expands to empty string', () => {
  const m: CaptureMatch = { start: 0, end: 1, captures: [null, { start: 0, end: 1 }] };
  assert.equal(replace('b', [m], ['<$1|$2>']).output, '<|b>');
});

test('invalid capture reference rejects the whole operation', () => {
  const m: CaptureMatch = { start: 0, end: 1, captures: [{ start: 0, end: 1 }] };
  assert.throws(() => parseTemplate('$2', 1), InvalidReferenceError);
  assert.throws(() => parseTemplate('$0', 1), InvalidReferenceError);
  assert.throws(() => replace('abc', [m], ['ok', '$2']), Error); // arity checked first
  assert.throws(
    () => replace('abc', [m, { start: 1, end: 2, captures: [] }], ['$1', '$1']),
    InvalidReferenceError, // second template references a group it does not have
  );
});

test('budget limits expansion length and aborts atomically', () => {
  const m: CaptureMatch = { start: 0, end: 3, captures: [] };
  assert.equal(replace('abc', [m], ['$&$&$&'], { maxOutputLength: 9 }).output, 'abcabcabc');
  assert.throws(
    () => replace('abc', [m], ['$&$&$&'], { maxOutputLength: 8 }),
    BudgetExceededError,
  );
  assert.throws(() => replace('abc', [m], ['xxxx'], { maxOutputLength: 3 }), BudgetExceededError);
});

test('overlapping or out-of-range matches are rejected', () => {
  const a: CaptureMatch = { start: 0, end: 2, captures: [] };
  const b: CaptureMatch = { start: 1, end: 3, captures: [] };
  assert.throws(() => replace('abc', [a, b], ['', '']), Error);
  assert.throws(
    () => replace('abc', [{ start: 0, end: 4, captures: [] }], ['']),
    Error,
  );
});

test('findMatches reports capture intervals and non-participating groups', () => {
  const matches = findMatches('a1-2b', /(\d)-(\d)/);
  assert.deepEqual(matches, [
    { start: 1, end: 4, captures: [{ start: 1, end: 2 }, { start: 3, end: 4 }] },
  ]);
  const alt = findMatches('b', /(a)|(b)/);
  assert.deepEqual(alt, [{ start: 0, end: 1, captures: [null, { start: 0, end: 1 }] }]);
});

test('zero-length matches advance one code point (surrogate-safe)', () => {
  const empty = findMatches('a\u{1F600}b', /(?:)/);
  assert.deepEqual(empty.map((m) => m.start), [0, 1, 3, 4]);
  const xs = findMatches('axb', /x*/);
  assert.deepEqual(
    xs.map((m) => [m.start, m.end]),
    [
      [0, 0],
      [1, 2],
      [2, 2],
      [3, 3],
    ],
  );
  // replacing every zero-length gap terminates and maps cleanly
  const { output } = replace('a\u{1F600}b', empty, empty.map(() => '|'));
  assert.equal(output, '|a|\u{1F600}|b|');
});
