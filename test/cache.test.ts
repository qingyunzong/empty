import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { CanonicalizationCache } from '../src/index.js';

describe('canonicalization cache', () => {
  test('same URL hits the same cached entry', () => {
    const cache = new CanonicalizationCache();
    const url = 'http://h/p?b=2&a=1';
    const first = cache.get(url);
    const second = cache.get(url);
    assert.equal(first, second);
    assert.equal(cache.size, 1);
  });

  test('canonical key collision with different original duplicates is not conflated', () => {
    const cache = new CanonicalizationCache();
    const urlA = 'http://h/p?a=1&a=2';
    const urlB = 'http://h/p?a=2&a=1';
    const a = cache.get(urlA);
    const b = cache.get(urlB);
    // both canonicalize to the same signing bytes...
    assert.equal(a.canonical, b.canonical);
    assert.equal(cache.distinctCanonicals, 1);
    // ...but the originals differ, so the cache must keep them apart
    assert.equal(cache.size, 2);
    assert.notEqual(a, b);
    // each entry keeps its own original-interval mapping
    assert.equal(urlA.slice(a.params[0]!.origStart, a.params[0]!.origEnd), 'a=1');
    assert.equal(urlB.slice(b.params[0]!.origStart, b.params[0]!.origEnd), 'a=1');
    assert.notEqual(a.params[0]!.origStart, b.params[0]!.origStart);
    assert.equal(a.original, urlA);
    assert.equal(b.original, urlB);
  });

  test('equivalent-but-different originals never share an entry', () => {
    const cache = new CanonicalizationCache();
    cache.get('/p/%7E');
    cache.get('/p/~');
    assert.equal(cache.distinctCanonicals, 1);
    assert.equal(cache.size, 2);
  });
});
