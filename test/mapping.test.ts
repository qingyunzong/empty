import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { canonicalizeUrl, replaceOriginalIntervals, CanonicalizationError } from '../src/index.js';

describe('original parameter mapping', () => {
  test('params carry their original raw text and intervals', () => {
    const url = 'http://h/p?b=2&a=%7E&a=1';
    const c = canonicalizeUrl(url);
    assert.equal(c.canonical, '/p?a=1&a=~&b=2');
    for (const param of c.params) {
      assert.equal(url.slice(param.origStart, param.origEnd), param.raw);
      assert.equal(c.canonical.slice(param.canonStart, param.canonEnd), 
        param.hasValue ? `${param.key}=${param.value}` : param.key);
    }
    // sorted order: a=1 (orig pair #2), a=~ (orig pair #1), b=2 (orig pair #0)
    assert.deepEqual(c.params.map((p) => p.raw), ['a=1', 'a=%7E', 'b=2']);
  });

  test('bidirectional mapping between canonical and original offsets', () => {
    const url = 'http://h/a/./b/%7E?b=2&a=1';
    const c = canonicalizeUrl(url);
    assert.equal(c.canonical, '/a/b/~?a=1&b=2');
    // canonical 'a=1' pair maps back to the original 'a=1' interval
    const pair = c.params[0]!;
    const origOff = c.map.canonicalToOriginal(pair.canonStart);
    assert.ok(origOff >= pair.origStart && origOff <= pair.origEnd);
    // original offset of the pair maps forward into its canonical interval
    const canonOff = c.map.originalToCanonical(pair.origStart);
    assert.ok(canonOff >= pair.canonStart && canonOff <= pair.canonEnd);
    // path segment 'b' in canonical maps into the original '/b' region
    const bCanon = c.canonical.indexOf('/b/') + 1;
    const bOrig = c.map.canonicalToOriginal(bCanon);
    assert.equal(url[bOrig], 'b');
  });
});

describe('signature field replacement by original intervals', () => {
  test('replace the sig parameter value using its original interval', () => {
    const url = 'http://h/p?data=x&sig=OLD&z=1';
    const c = canonicalizeUrl(url);
    const sig = c.params.find((p) => p.key === 'sig')!;
    const eqOffset = sig.raw.indexOf('=');
    const signed = replaceOriginalIntervals(url, [
      { start: sig.origStart + eqOffset + 1, end: sig.origEnd, value: 'NEW123' },
    ]);
    assert.equal(signed, 'http://h/p?data=x&sig=NEW123&z=1');
  });

  test('multiple replacements apply atomically', () => {
    const url = 'http://h/old/path?sig=A&ts=1';
    const c = canonicalizeUrl(url);
    const sig = c.params.find((p) => p.key === 'sig')!;
    const ts = c.params.find((p) => p.key === 'ts')!;
    const pathStart = url.indexOf('/old');
    const pathEnd = url.indexOf('?');
    const out = replaceOriginalIntervals(url, [
      { start: sig.origStart, end: sig.origEnd, value: 'sig=SHA256SIG' },
      { start: ts.origStart, end: ts.origEnd, value: 'ts=999' },
      { start: pathStart, end: pathEnd, value: '/new/path' },
    ]);
    assert.equal(out, 'http://h/new/path?sig=SHA256SIG&ts=999');
  });

  test('an invalid edit set rejects everything and leaves the input untouched', () => {
    const url = 'http://h/p?sig=A&ts=1';
    const c = canonicalizeUrl(url);
    const sig = c.params.find((p) => p.key === 'sig')!;
    const ts = c.params.find((p) => p.key === 'ts')!;
    // overlapping edits -> whole batch rejected
    assert.throws(
      () =>
        replaceOriginalIntervals(url, [
          { start: sig.origStart, end: sig.origEnd, value: 'sig=X' },
          { start: sig.origStart + 1, end: sig.origEnd + 2, value: 'y' },
        ]),
      CanonicalizationError,
    );
    // out-of-range edit -> whole batch rejected
    assert.throws(
      () =>
        replaceOriginalIntervals(url, [
          { start: ts.origStart, end: ts.origEnd, value: 'ts=2' },
          { start: 0, end: url.length + 1, value: 'nope' },
        ]),
      CanonicalizationError,
    );
    assert.equal(url, 'http://h/p?sig=A&ts=1');
  });
});
