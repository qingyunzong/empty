import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CanonicalizationCache } from '../src/index.js';

test('canonical-key collision with different original duplicates never shares cache entries', () => {
  const cache = new CanonicalizationCache();
  const u1 = '/p?b=2&b=1';
  const u2 = '/p?b=1&b=2';

  const c1 = cache.get(u1);
  const c2 = cache.get(u2);

  // same canonical form (canonical key collision)...
  assert.equal(c1.canonical, '/p?b=1&b=2');
  assert.equal(c2.canonical, '/p?b=1&b=2');

  // ...but the originals differ, so entries must not be mixed up
  assert.equal(cache.size, 2);
  assert.notEqual(c1, c2);
  assert.equal(c1.params[0].origIndex, 1); // 'b=1' was the 2nd pair in u1
  assert.equal(c2.params[0].origIndex, 0); // 'b=1' was the 1st pair in u2
  assert.equal(u1.slice(c1.params[0].origPair.start, c1.params[0].origPair.end), 'b=1');
  assert.equal(u2.slice(c2.params[0].origPair.start, c2.params[0].origPair.end), 'b=1');
});

test('identical originals are memoized', () => {
  const cache = new CanonicalizationCache();
  const a = cache.get('/x?b=2&b=1');
  const b = cache.get('/x?b=2&b=1');
  assert.equal(a, b);
  assert.equal(cache.size, 1);
});
