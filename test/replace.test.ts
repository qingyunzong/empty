import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyEditsAtomic,
  canonicalizeUrl,
  replaceParamValues,
} from '../src/index.js';

const RAW = 'http://h/p?b=2&a=1';

test('replace a signed field by its original range, then re-canonicalize', () => {
  const c = canonicalizeUrl(RAW);
  const next = replaceParamValues(RAW, c, [{ canonIndex: 0, newValue: '99' }]);
  assert.equal(next.raw, 'http://h/p?b=2&a=99');
  assert.equal(next.canonical, 'http://h/p?a=99&b=2');
});

test('multiple replacements apply atomically', () => {
  const c = canonicalizeUrl(RAW);
  const next = replaceParamValues(RAW, c, [
    { canonIndex: 0, newValue: '9' }, // a
    { canonIndex: 1, newValue: '8' }, // b
  ]);
  assert.equal(next.raw, 'http://h/p?b=8&a=9');
  assert.equal(next.canonical, 'http://h/p?a=9&b=8');
});

test('bare key (no =) can be given a value', () => {
  const raw = '?flag&a=1';
  const c = canonicalizeUrl(raw);
  const flag = c.params.find((p) => p.key === 'flag');
  assert.ok(flag);
  const next = replaceParamValues(raw, c, [{ canonIndex: flag.canonIndex, newValue: 'true' }]);
  assert.equal(next.raw, '?flag=true&a=1');
  assert.equal(next.canonical, '?a=1&flag=true');
});

test('overlapping edits are rejected as a whole; nothing is applied', () => {
  assert.throws(
    () => applyEditsAtomic(RAW, [
      { start: 0, end: 5, text: 'x' },
      { start: 3, end: 6, text: 'y' },
    ]),
    RangeError,
  );
  assert.throws(() => applyEditsAtomic(RAW, [{ start: -1, end: 2, text: 'x' }]), RangeError);
  assert.throws(
    () => applyEditsAtomic(RAW, [{ start: 0, end: RAW.length + 1, text: 'x' }]),
    RangeError,
  );
});

test('unknown canonical index rejects the batch', () => {
  const c = canonicalizeUrl(RAW);
  assert.throws(
    () =>
      replaceParamValues(RAW, c, [
        { canonIndex: 0, newValue: '9' },
        { canonIndex: 42, newValue: 'x' },
      ]),
    RangeError,
  );
  // the valid replacement in the same batch was not applied either
  assert.equal(RAW, 'http://h/p?b=2&a=1');
});
