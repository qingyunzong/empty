import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { maskJson, JsonSyntaxError } from '../src/index.js';

const INVALID: Array<[string, string]> = [
  ['', 'empty input'],
  ['   ', 'whitespace only'],
  ['{', 'unterminated object'],
  ['{"a"', 'unterminated after key'],
  ['{"a":', 'missing value'],
  ['{"a":}', 'missing value before brace'],
  ['{"a":1', 'unterminated object after value'],
  ['{"a":1,}', 'trailing comma in object'],
  ['{,}', 'comma without member'],
  ['{"a" 1}', 'missing colon'],
  ['{"a":1 "b":2}', 'missing comma in object'],
  ['[', 'unterminated array'],
  ['[1', 'unterminated array after value'],
  ['[1,]', 'trailing comma in array'],
  ['[1 2]', 'missing comma in array'],
  ['{]', 'mismatched closing bracket'],
  ['[}', 'mismatched closing brace'],
  ['"abc', 'unterminated string'],
  ['"a\nb"', 'raw control character in string'],
  ['"\\x"', 'invalid escape'],
  ['"\\u12G4"', 'invalid hex in unicode escape'],
  ['"\\u123"', 'truncated unicode escape'],
  ['01', 'leading zero'],
  ['- ', 'lone minus'],
  ['+1', 'leading plus'],
  ['1.', 'missing fraction digits'],
  ['1e', 'missing exponent digits'],
  ['1e+', 'missing exponent digits after sign'],
  ['.5', 'leading dot'],
  ['tru', 'truncated literal'],
  ['truex', 'garbage after literal'],
  ['nul', 'truncated null'],
  ['True', 'capitalized literal'],
  ['true false', 'two top-level values'],
  ['{} {}', 'trailing value after object'],
  ['[]x', 'trailing garbage after array'],
  ["'single'", 'single-quoted string'],
  ['{a:1}', 'unquoted key'],
];

for (const [input, label] of INVALID) {
  test(`rejects invalid JSON: ${label}`, () => {
    assert.throws(() => maskJson(input, []), JsonSyntaxError, JSON.stringify(input));
  });
}

test('rejects invalid JSON fed in chunks', () => {
  assert.throws(() => maskJson('{"a":01}', []), JsonSyntaxError);
});

const VALID: Array<[string, string]> = [
  ['0', 'zero'],
  ['-0', 'negative zero'],
  ['1e2', 'exponent'],
  ['0.10', 'trailing fraction zeros'],
  ['-0.5E+10', 'signed exponent'],
  ['true', 'true'],
  ['false', 'false'],
  ['null', 'null'],
  ['"\\uD834\\uDD1E"', 'surrogate pair'],
  ['"\\/"', 'escaped slash'],
  [' { } ', 'empty object with whitespace'],
  ['[]', 'empty array'],
  ['[[]]', 'nested empty array'],
  ['{"":""}', 'empty key and value'],
  ['\t{\r\n\t"a"\t:\t[1\t,\t2]\r\n}\t', 'mixed whitespace'],
];

for (const [input, label] of VALID) {
  test(`accepts legal JSON unchanged: ${label}`, () => {
    assert.equal(maskJson(input, []), input);
  });
}

test('error carries the offset of the problem', () => {
  try {
    maskJson('{"a": 01}', []);
    assert.ok(false, 'expected JsonSyntaxError');
  } catch (err) {
    assert.ok(err instanceof JsonSyntaxError);
    assert.equal(typeof err.offset, 'number');
    assert.match(err.message, /offset \d+/);
  }
});
