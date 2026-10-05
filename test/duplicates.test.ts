import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { maskJson, JsonMasker, DuplicateKeyError } from '../src/index.js';

test('rejects duplicate keys in the same object', () => {
  assert.throws(() => maskJson('{"a":1,"a":2}', []), DuplicateKeyError);
  assert.throws(() => maskJson('{"a":1,"b":2,"a":3}', []), DuplicateKeyError);
});

test('rejects duplicate decoded keys written with different escapes', () => {
  assert.throws(() => maskJson('{"a":1,"\\u0061":2}', []), DuplicateKeyError);
  assert.throws(() => maskJson('{"\\u0061":1,"a":2}', []), DuplicateKeyError);
  assert.throws(() => maskJson('{"AB":1,"A\\u0042":2}', []), DuplicateKeyError);
  assert.throws(() => maskJson('{"\\t":1,"\\u0009":2}', []), DuplicateKeyError);
});

test('duplicate rejection happens before any masking output', () => {
  // A signature verifier reading the first "token" and a display path
  // reading the last one would see different values; the library must
  // refuse the document instead of masking either occurrence.
  const input = '{"token":"secret","token":"public"}';
  assert.throws(() => maskJson(input, ['/token']), DuplicateKeyError);
  const masker = new JsonMasker({ pointers: ['/token'] });
  assert.throws(() => {
    masker.write(input);
    masker.end();
  }, DuplicateKeyError);
});

test('error reports the object pointer, decoded key and offset', () => {
  try {
    maskJson('{"outer":{"a":1,"\\u0061":2}}', []);
    assert.ok(false, 'expected DuplicateKeyError');
  } catch (err) {
    assert.ok(err instanceof DuplicateKeyError);
    assert.equal(err.pointer, '/outer');
    assert.equal(err.key, 'a');
    assert.equal(typeof err.offset, 'number');
    assert.match(err.message, /Duplicate decoded key "a"/);
  }
});

test('same key in sibling objects is legal', () => {
  const input = '{"x":{"a":1},"y":{"a":2}}';
  assert.equal(maskJson(input, []), input);
});

test('same key at different depths is legal', () => {
  const input = '{"a":{"a":{"a":1}}}';
  assert.equal(maskJson(input, []), input);
});

test('same key in different array elements is legal', () => {
  const input = '[{"a":1},{"a":2},{"a":3}]';
  assert.equal(maskJson(input, []), input);
});

test('duplicate keys inside nested containers are rejected', () => {
  assert.throws(() => maskJson('{"x":{"a":1,"a":2}}', []), DuplicateKeyError);
  assert.throws(() => maskJson('[{"a":1,"a":2}]', []), DuplicateKeyError);
  assert.throws(() => maskJson('{"x":[{"y":{"k":1,"k":2}}]}', []), DuplicateKeyError);
});

test('duplicate keys are rejected even when input arrives in chunks', () => {
  const masker = new JsonMasker({ pointers: [] });
  assert.throws(() => {
    masker.write('{"a":1,');
    masker.write('"a":2}');
    masker.end();
  }, DuplicateKeyError);
});

test('duplicate decoded key split across chunk boundary is rejected', () => {
  const masker = new JsonMasker({ pointers: [] });
  assert.throws(() => {
    masker.write('{"a":1,"\\u');
    masker.write('0061":2}');
    masker.end();
  }, DuplicateKeyError);
});
