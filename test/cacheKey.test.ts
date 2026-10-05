import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCacheKey, cacheKeyEquals, CacheKeyError } from '../src/cacheKey.js';

const OPTS = { keyHeaders: ['Accept', 'X-Mode', 'Cookie'] } as const;

function keyOf(req: Parameters<typeof buildCacheKey>[0], opts = OPTS): string {
  return buildCacheKey(req, opts).key;
}

test('method is uppercased and validated', () => {
  assert.equal(
    keyOf({ method: 'get', target: '/a' }),
    keyOf({ method: 'GET', target: '/a' })
  );
  assert.throws(() => buildCacheKey({ method: 'GE T', target: '/a' }, OPTS), CacheKeyError);
  assert.throws(() => buildCacheKey({ method: '', target: '/a' }, OPTS), CacheKeyError);
});

test('path normalization: dot segments, unreserved decoding, hex case', () => {
  const base = keyOf({ method: 'GET', target: '/a/b' });
  assert.equal(keyOf({ method: 'GET', target: '/a/./b' }), base);
  assert.equal(keyOf({ method: 'GET', target: '/a/c/../b' }), base);
  assert.equal(keyOf({ method: 'GET', target: '/%61/b' }), base);
  assert.equal(keyOf({ method: 'GET', target: '/a/%62' }), base);
  assert.equal(keyOf({ method: 'GET', target: '/%7Ex' }), keyOf({ method: 'GET', target: '/~x' }));
  // Reserved characters stay encoded: %2F is NOT "/".
  assert.notEqual(keyOf({ method: 'GET', target: '/a%2Fb' }), keyOf({ method: 'GET', target: '/a/b' }));
  // Double slashes and trailing slashes are significant.
  assert.notEqual(keyOf({ method: 'GET', target: '/a//b' }), base);
  assert.notEqual(keyOf({ method: 'GET', target: '/a/b/' }), base);
  // Empty path normalizes to "/".
  assert.equal(keyOf({ method: 'GET', target: '?x=1' }), keyOf({ method: 'GET', target: '/?x=1' }));
});

test('query: percent normalization, order and absence preserved', () => {
  assert.equal(keyOf({ method: 'GET', target: '/a?x=%31' }), keyOf({ method: 'GET', target: '/a?x=1' }));
  assert.notEqual(keyOf({ method: 'GET', target: '/a?x=1&y=2' }), keyOf({ method: 'GET', target: '/a?y=2&x=1' }));
  assert.notEqual(keyOf({ method: 'GET', target: '/a' }), keyOf({ method: 'GET', target: '/a?' }));
});

test('malformed targets and percent-encodings are rejected', () => {
  assert.throws(() => buildCacheKey({ method: 'GET', target: '/a%zz' }, OPTS), CacheKeyError);
  assert.throws(() => buildCacheKey({ method: 'GET', target: '/a%1' }, OPTS), CacheKeyError);
  assert.throws(() => buildCacheKey({ method: 'GET', target: 'a/b' }, OPTS), CacheKeyError);
  assert.throws(() => buildCacheKey({ method: 'GET', target: '/a b' }, OPTS), CacheKeyError);
});

test('header names are case-insensitive, values trimmed and list-normalized', () => {
  const base = keyOf({ method: 'GET', target: '/a', headers: [['Accept', 'a, b']] });
  assert.equal(keyOf({ method: 'GET', target: '/a', headers: [['accept', 'a,b']] }), base);
  assert.equal(keyOf({ method: 'GET', target: '/a', headers: [['ACCEPT', '  a ,\tb  ']] }), base);
  assert.equal(keyOf({ method: 'GET', target: '/a', headers: [['accept', 'a,,b']] }), base);
  // Quoted commas are not list separators; quoted interiors are preserved.
  assert.notEqual(
    keyOf({ method: 'GET', target: '/a', headers: [['accept', '"a, b"']] }),
    base
  );
  assert.notEqual(
    keyOf({ method: 'GET', target: '/a', headers: [['accept', '"x  y"']] }),
    keyOf({ method: 'GET', target: '/a', headers: [['accept', '"x y"']] })
  );
});

test('duplicate keyed headers merge per RFC rules', () => {
  const merged = keyOf({ method: 'GET', target: '/a', headers: [['accept', 'a, b']] });
  assert.equal(keyOf({ method: 'GET', target: '/a', headers: [['accept', 'a'], ['Accept', 'b']] }), merged);
  // Merge order is significant (list order matters).
  assert.notEqual(
    keyOf({ method: 'GET', target: '/a', headers: [['accept', 'b'], ['accept', 'a']] }),
    merged
  );
  // Cookie duplicates merge with "; ".
  const cookie = keyOf({ method: 'GET', target: '/a', headers: [['cookie', 'a=1; b=2']] });
  assert.equal(keyOf({ method: 'GET', target: '/a', headers: [['cookie', 'a=1'], ['cookie', 'b=2']] }), cookie);
  assert.equal(keyOf({ method: 'GET', target: '/a', headers: [['cookie', 'a=1 ;b=2']] }), cookie);
  // set-cookie must not be merged.
  assert.throws(
    () =>
      buildCacheKey(
        { method: 'GET', target: '/a', headers: [['set-cookie', 'x=1'], ['set-cookie', 'y=2']] },
        { keyHeaders: ['set-cookie'] }
      ),
    CacheKeyError
  );
});

test('keyed header order in the request does not matter', () => {
  const a = keyOf({ method: 'GET', target: '/a', headers: [['accept', 'x'], ['x-mode', '1']] });
  const b = keyOf({ method: 'GET', target: '/a', headers: [['x-mode', '1'], ['accept', 'x']] });
  assert.equal(a, b);
});

test('headers containing CR or LF are rejected, keyed or not', () => {
  assert.throws(
    () => buildCacheKey({ method: 'GET', target: '/a', headers: [['accept', 'a\nb']] }, OPTS),
    CacheKeyError
  );
  assert.throws(
    () => buildCacheKey({ method: 'GET', target: '/a', headers: [['accept', 'a\r\nb']] }, OPTS),
    CacheKeyError
  );
  assert.throws(
    () => buildCacheKey({ method: 'GET', target: '/a', headers: [['x-ignored', 'evil\ninjected: yes']] }, OPTS),
    CacheKeyError
  );
  assert.throws(
    () => buildCacheKey({ method: 'GET', target: '/a', headers: [['bad name', 'v']] }, OPTS),
    CacheKeyError
  );
  assert.throws(
    () => buildCacheKey({ method: 'GET', target: '/a', headers: [['x-a', '\u0001']] }, OPTS),
    CacheKeyError
  );
});

test('ignored headers do not affect the key but are kept with audit provenance', () => {
  const without = buildCacheKey({ method: 'GET', target: '/a', headers: [['accept', 'x']] }, OPTS);
  const withIgnored = buildCacheKey(
    {
      method: 'GET',
      target: '/a',
      headers: [['accept', 'x'], ['X-Extra', '1'], ['x-extra', '2']],
    },
    OPTS
  );
  assert.ok(cacheKeyEquals(without, withIgnored));
  assert.deepEqual(withIgnored.audit.ignored, [
    { kind: 'header', name: 'X-Extra', value: '1', source: 'headers[1]' },
    { kind: 'header', name: 'x-extra', value: '2', source: 'headers[2]' },
  ]);
  // Keyed headers are not reported as ignored.
  assert.equal(without.audit.ignored.length, 0);
});

test('record-form headers expand with provenance and match tuple form', () => {
  const tupleForm = buildCacheKey(
    { method: 'GET', target: '/a', headers: [['Accept', 'x'], ['accept', 'y'], ['z-skip', '1']] },
    OPTS
  );
  const recordForm = buildCacheKey(
    { method: 'GET', target: '/a', headers: { Accept: ['x', 'y'], 'z-skip': '1' } },
    OPTS
  );
  assert.equal(tupleForm.key, recordForm.key);
  assert.deepEqual(recordForm.audit.ignored, [
    { kind: 'header', name: 'z-skip', value: '1', source: 'headers.z-skip' },
  ]);
  const rec = buildCacheKey(
    { method: 'GET', target: '/a', headers: { 'z-skip': ['1', '2'] } },
    OPTS
  );
  assert.deepEqual(rec.audit.ignored.map((f) => f.source), ['headers.z-skip[0]', 'headers.z-skip[1]']);
});

test('key serialization is injective across components', () => {
  // Crafted so a naive delimiter join would collide: ("ab","c") vs ("a","bc").
  const a = keyOf({ method: 'GET', target: '/ab', headers: [['accept', 'c']] });
  const b = keyOf({ method: 'GET', target: '/a', headers: [['accept', 'bc']] });
  assert.notEqual(a, b);
});

test('empty-valued keyed header is semantically absent', () => {
  assert.equal(
    keyOf({ method: 'GET', target: '/a', headers: [['accept', '']] }),
    keyOf({ method: 'GET', target: '/a' })
  );
  assert.equal(
    keyOf({ method: 'GET', target: '/a', headers: [['accept', ',']] }),
    keyOf({ method: 'GET', target: '/a' })
  );
});

test('normalized view exposes canonical components', () => {
  const { normalized } = buildCacheKey(
    { method: 'get', target: '/a/c/../b?x=%31', headers: [['Accept', ' a ,b '], ['x-mode', '1']] },
    OPTS
  );
  assert.deepEqual(normalized, {
    method: 'GET',
    path: '/a/b',
    query: 'x=1',
    headers: [
      ['accept', 'a, b'],
      ['x-mode', '1'],
    ],
  });
});
