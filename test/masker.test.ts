import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  JsonMasker,
  maskJson,
  DuplicateKeyError,
  InvalidPointerError,
  JsonSyntaxError,
} from '../src/index';

function mask(input: string, pointers: string[], replacement?: string): string {
  return maskJson(input, { pointers, replacement });
}

/** Feed input one character at a time (maximally fragmented chunks). */
function maskBytewise(input: string, pointers: string[]): string {
  const masker = new JsonMasker({ pointers });
  for (const ch of input) {
    masker.feed(ch);
  }
  return masker.end();
}

test('masks a target value and preserves every other byte', () => {
  const input = '{\n  "a": 1,  "secret" : "x",\n  "b": [1, 2, 3]\n}';
  const out = mask(input, ['/secret']);
  assert.equal(out, '{\n  "a": 1,  "secret" : "***",\n  "b": [1, 2, 3]\n}');
});

test('number lexemes are preserved verbatim for non-target values', () => {
  const input = '{"n1":1e2,"n2":0.500,"n3":-0,"n4":1E+10,"n5":9007199254740993,"hide":7}';
  const out = mask(input, ['/hide']);
  assert.equal(out, '{"n1":1e2,"n2":0.500,"n3":-0,"n4":1E+10,"n5":9007199254740993,"hide":"***"}');
});

test('non-target string escape forms are preserved byte-for-byte', () => {
  const input = '{"a":"x\\ny","b":"\\u0041z","c":"tab\\there"}';
  const out = mask(input, ['/a']);
  assert.equal(out, '{"a":"***","b":"\\u0041z","c":"tab\\there"}');
});

test('rejects identical duplicate keys', () => {
  assert.throws(() => mask('{"a":1,"a":2}', []), DuplicateKeyError);
});

test('rejects duplicate decoded keys (escape vs literal)', () => {
  assert.throws(() => mask('{"a":1,"\\u0061":2}', []), DuplicateKeyError);
  assert.throws(() => mask('{"\\u0041":1,"A":2}', []), DuplicateKeyError);
});

test('rejects duplicate keys in nested objects and reports the pointer', () => {
  try {
    mask('{"x":{"k":1,"k":2}}', []);
    assert.ok(false, 'should have thrown');
  } catch (err) {
    assert.ok(err instanceof DuplicateKeyError);
    assert.equal((err as InstanceType<typeof DuplicateKeyError>).pointer, '/x');
    assert.equal((err as InstanceType<typeof DuplicateKeyError>).key, 'k');
  }
});

test('rejects duplicates even inside a masked subtree, before producing output', () => {
  assert.throws(() => mask('{"a":{"k":1,"k":2}}', ['/a']), DuplicateKeyError);
});

test('rejects duplicates formed by surrogate-pair escapes vs literal emoji', () => {
  assert.throws(() => mask('{"\\uD83D\\uDE00":1,"😀":2}', []), DuplicateKeyError);
});

test('same key in different objects is allowed', () => {
  const input = '{"a":{"k":1},"b":{"k":2}}';
  assert.equal(mask(input, []), input);
});

test('masks nested values via multi-segment pointers and array indices', () => {
  const input = '{"a":[{"b":1},{"b":2}],"c":3}';
  assert.equal(mask(input, ['/a/1/b']), '{"a":[{"b":1},{"b":"***"}],"c":3}');
});

test('supports RFC 6901 escaped pointer segments', () => {
  const input = '{"a/b":1,"m~n":2}';
  assert.equal(mask(input, ['/a~1b', '/m~0n']), '{"a/b":"***","m~n":"***"}');
});

test('masks an entire subtree as one span', () => {
  const input = '{"a":{"x":1,"y":[2,3]},"b":4}';
  assert.equal(mask(input, ['/a']), '{"a":"***","b":4}');
  const arr = '{"a":[1,{"z":2}],"b":4}';
  assert.equal(mask(arr, ['/a']), '{"a":"***","b":4}');
});

test('empty pointer masks the whole document', () => {
  assert.equal(mask('{"a":1}', ['']), '"***"');
  // Whitespace around the root value is non-target bytes and is preserved.
  assert.equal(mask('  [1, 2]  ', ['']), '  "***"  ');
});

test('custom replacement is spliced in raw', () => {
  assert.equal(mask('{"a":1}', ['/a'], 'null'), '{"a":null}');
  assert.equal(mask('{"a":1}', ['/a'], '"[REDACTED]"'), '{"a":"[REDACTED]"}');
});

test('invalid replacement is rejected up front', () => {
  assert.throws(() => new JsonMasker({ pointers: [], replacement: '{bad' }), JsonSyntaxError);
});

test('invalid pointers are rejected up front', () => {
  assert.throws(() => new JsonMasker({ pointers: ['a'] }), InvalidPointerError);
  assert.throws(() => new JsonMasker({ pointers: ['/a~2b'] }), InvalidPointerError);
});

test('masked output is valid JSON and parses to the expected value', () => {
  const out = mask('{"user":{"name":"ann","ssn":"123-45"},"n":1e2}', ['/user/ssn']);
  const parsed = JSON.parse(out) as { user: { name: string; ssn: string }; n: number };
  assert.equal(parsed.user.ssn, '***');
  assert.equal(parsed.user.name, 'ann');
  assert.equal(parsed.n, 100);
});

test('cross-chunk escape: key split mid-\\u still detects duplicates', () => {
  const masker = new JsonMasker({ pointers: [] });
  assert.throws(() => {
    masker.feed('{"\\u00');
    masker.feed('41": 1, "');
    masker.feed('A": 2}');
    masker.end();
  }, DuplicateKeyError);
});

test('cross-chunk escape: backslash at chunk boundary inside a string', () => {
  const masker = new JsonMasker({ pointers: ['/a'] });
  masker.feed('{"a": "x');
  masker.feed('\\');
  masker.feed('ny", "b": 1}');
  assert.equal(masker.end(), '{"a": "***", "b": 1}');
});

test('cross-chunk surrogate pair split across feeds decodes to one key', () => {
  const masker = new JsonMasker({ pointers: [] });
  assert.throws(() => {
    masker.feed('{"\\uD83');
    masker.feed('D\\uDE00": 1, "😀": 2}');
    masker.end();
  }, DuplicateKeyError);
});

test('byte-by-byte feeding matches one-shot masking', () => {
  const input = '{"k e y": [1e2, {"~x/": "v"}], "s": "a\\u0041b", "hide": {"n": -0.5e+3}}';
  const pointers = ['/k e y/1/~0x~1', '/hide'];
  assert.equal(maskBytewise(input, pointers), mask(input, pointers));
  assert.equal(
    maskBytewise(input, pointers),
    '{"k e y": [1e2, {"~x/": "***"}], "s": "a\\u0041b", "hide": "***"}',
  );
});

test('rejects invalid JSON: unterminated string', () => {
  assert.throws(() => mask('{"a": "x}', []), JsonSyntaxError);
});

test('rejects invalid JSON: bad numbers', () => {
  assert.throws(() => mask('{"a": 01}', []), JsonSyntaxError);
  assert.throws(() => mask('{"a": 1.}', []), JsonSyntaxError);
  assert.throws(() => mask('{"a": 1e}', []), JsonSyntaxError);
  assert.throws(() => mask('{"a": +1}', []), JsonSyntaxError);
});

test('rejects invalid JSON: trailing comma and trailing garbage', () => {
  assert.throws(() => mask('{"a":1,}', []), JsonSyntaxError);
  assert.throws(() => mask('{} {}', []), JsonSyntaxError);
  assert.throws(() => mask('[1,]', []), JsonSyntaxError);
});

test('rejects invalid JSON: bad literal and control char in string', () => {
  assert.throws(() => mask('{"a": tru}', []), JsonSyntaxError);
  assert.throws(() => mask('{"a": "x\ny"}', []), JsonSyntaxError);
});

test('rejects empty input and truncated containers', () => {
  assert.throws(() => mask('', []), JsonSyntaxError);
  assert.throws(() => mask('{"a": [1, 2}', []), JsonSyntaxError);
});

test('root scalars can be masked', () => {
  assert.equal(mask('42', ['']), '"***"');
  assert.equal(mask('"secret"', ['']), '"***"');
  assert.equal(mask('true', []), 'true');
});
