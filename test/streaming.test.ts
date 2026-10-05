import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { JsonMasker, maskJson } from '../src/index.js';

function maskChunked(input: string, splitAt: number, pointers: string[]): string {
  const masker = new JsonMasker({ pointers });
  masker.write(input.slice(0, splitAt));
  masker.write(input.slice(splitAt));
  return masker.end();
}

test('escape sequence split across chunks still decodes the key', () => {
  const input = '{"k\\u0065y":"secret","other":2}';
  const expected = maskJson(input, ['/key']);
  assert.equal(expected, '{"k\\u0065y":"***","other":2}');
  // Split inside the \\u0041-style escape at every possible position.
  for (let i = 0; i <= input.length; i++) {
    assert.equal(maskChunked(input, i, ['/key']), expected, `split at ${i}`);
  }
});

test('every two-way split of a document matches the one-shot result', () => {
  const input =
    '{"user":{"name":"ann","token":"s\\u0065cret"},"nums":[1e2,0.10,-3],"ok":true,"nil":null}';
  const pointers = ['/user/token', '/nums/1'];
  const expected = maskJson(input, pointers);
  for (let i = 0; i <= input.length; i++) {
    assert.equal(maskChunked(input, i, pointers), expected, `split at ${i}`);
  }
});

test('random multi-chunk splits match the one-shot result', () => {
  const input =
    '{"a":[1,{"b":"x\\ty"},"c\\u0041"],"big":-1.25E+10,"s":"\\u0041\\u00e9\\ud834\\udd1e"}';
  const pointers = ['/a/1/b', '/s'];
  const expected = maskJson(input, pointers);
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let trial = 0; trial < 200; trial++) {
    const masker = new JsonMasker({ pointers });
    let rest = input;
    while (rest.length > 0) {
      const n = 1 + Math.floor(rand() * Math.min(rest.length, 7));
      masker.write(rest.slice(0, n));
      rest = rest.slice(n);
    }
    assert.equal(masker.end(), expected, `trial ${trial}`);
  }
});

test('surrogate pair escape split across chunks decodes for key matching', () => {
  const input = '{"\\ud834\\udd1e":"secret"}';
  const pointer = '/\u{1d11e}';
  assert.equal(maskJson(input, [pointer]), '{"\\ud834\\udd1e":"***"}');
  for (let i = 0; i <= input.length; i++) {
    assert.equal(maskChunked(input, i, [pointer]), '{"\\ud834\\udd1e":"***"}', `split at ${i}`);
  }
});

test('number token split across chunks is validated and preserved', () => {
  const input = '{"n":-1.25E+10,"m":2}';
  for (let i = 0; i <= input.length; i++) {
    assert.equal(maskChunked(input, i, ['/m']), '{"n":-1.25E+10,"m":"***"}', `split at ${i}`);
  }
});

test('literal tokens split across chunks parse correctly', () => {
  const input = '[true,false,null]';
  for (let i = 0; i <= input.length; i++) {
    assert.equal(maskChunked(input, i, ['/1']), '[true,"***",null]', `split at ${i}`);
  }
});

test('byte-at-a-time streaming of a larger document', () => {
  const parts: string[] = [];
  for (let i = 0; i < 50; i++) {
    parts.push(`{"id":${i},"secret":"s${i}","v":${i}.5e${i % 3}}`);
  }
  const input = '[' + parts.join(',') + ']';
  const pointers = ['/12/secret', '/49/v'];
  const expected = maskJson(input, pointers);
  const masker = new JsonMasker({ pointers });
  for (const ch of input) {
    masker.write(ch);
  }
  assert.equal(masker.end(), expected);
});

test('write after end throws', () => {
  const masker = new JsonMasker({ pointers: [] });
  masker.write('{}');
  masker.end();
  assert.throws(() => masker.write('{}'), /write\(\) after end\(\)/);
  assert.throws(() => masker.end(), /end\(\) called twice/);
});
