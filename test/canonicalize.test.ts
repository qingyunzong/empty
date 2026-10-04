import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeUrl, CanonicalizationError } from '../src/index.js';

test('path: dot segments are removed (RFC 3986 5.2.4)', () => {
  assert.equal(canonicalizeUrl('/a/b/../c/./d').canonical, '/a/c/d');
  assert.equal(canonicalizeUrl('/a/..').canonical, '/');
  assert.equal(canonicalizeUrl('/a/./').canonical, '/a/');
  assert.equal(canonicalizeUrl('/').canonical, '/');
  assert.equal(canonicalizeUrl('../a/b').canonical, '/a/b');
  assert.equal(canonicalizeUrl('/a/b/c/../../g').canonical, '/a/g');
});

test('path: encoded dot segments are decoded then removed', () => {
  assert.equal(canonicalizeUrl('/a/%2e%2e/b').canonical, '/b');
  assert.equal(canonicalizeUrl('/a/%2E/b').canonical, '/a/b');
});

test('percent: only unreserved ASCII is decoded', () => {
  assert.equal(canonicalizeUrl('/a%62c').canonical, '/abc');
  assert.equal(canonicalizeUrl('/%7e').canonical, '/~');
  assert.equal(
    canonicalizeUrl('/%41%5A%61%7a%30%39%2d%2e%5f%7e').canonical,
    '/AZaz09-._~',
  );
});

test('percent: reserved characters stay encoded, hex uppercased', () => {
  assert.equal(canonicalizeUrl('/%2f%3F').canonical, '/%2F%3F');
  assert.equal(
    canonicalizeUrl('/%21%24%26%27%28%29%2a%2b%2c%3b%3d%3a%40%5b%5d%23%3f%25').canonical,
    '/%21%24%26%27%28%29%2A%2B%2C%3B%3D%3A%40%5B%5D%23%3F%25',
  );
});

test('percent: non-ASCII bytes stay encoded', () => {
  assert.equal(canonicalizeUrl('/caf%c3%a9').canonical, '/caf%C3%A9');
});

test('invalid escape rejects the whole normalization', () => {
  for (const bad of ['/a%', '/a%2', '/a%GG', '/a%g1', '?x=%1', '?x=100%', '/%']) {
    assert.throws(() => canonicalizeUrl(bad), CanonicalizationError, bad);
  }
  const err = (() => {
    try {
      canonicalizeUrl('/ok%XX');
    } catch (e) {
      return e as CanonicalizationError;
    }
    throw new Error('expected throw');
  })();
  assert.equal(err.offset, 3);
});

test('query: duplicate keys preserved, sorted by key then value bytes', () => {
  assert.equal(canonicalizeUrl('?b=2&a=1&b=1').canonical, '?a=1&b=1&b=2');
  const dup = canonicalizeUrl('?a=1&a=1');
  assert.equal(dup.canonical, '?a=1&a=1');
  assert.equal(dup.params.length, 2);
  // byte order, not numeric order: '10' < '2'
  assert.equal(canonicalizeUrl('?a=2&a=10').canonical, '?a=10&a=2');
});

test('query: bare keys keep their shape', () => {
  const c = canonicalizeUrl('?b&a=1');
  assert.equal(c.canonical, '?a=1&b');
  assert.equal(c.params[1].hasEquals, false);
  assert.equal(c.params[1].origValue, null);
});

test('query: unreserved escapes decoded inside pairs', () => {
  assert.equal(canonicalizeUrl('?x=%41&x=%41').canonical, '?x=A&x=A');
  assert.equal(canonicalizeUrl('?k=%26').canonical, '?k=%26');
});

test('full URL: scheme/authority prefix and fragment carried through', () => {
  assert.equal(
    canonicalizeUrl('https://a.b:8080/x/../y?q=1#frag').canonical,
    'https://a.b:8080/y?q=1#frag',
  );
});

test('second normalization is idempotent', () => {
  const urls = [
    '/a/b/../c/./d?b=2&a=%41&b=1#f',
    '/%7e%2f%41?a=2&a=10&a=2',
    'https://h:443/p/./q?z&z=1&a=%2e',
    '?b=2&b=1',
    '/caf%c3%a9/%2e%2e/x',
    '?',
  ];
  for (const u of urls) {
    const once = canonicalizeUrl(u);
    const twice = canonicalizeUrl(once.canonical);
    assert.equal(twice.canonical, once.canonical, `idempotency failed for ${u}`);
    assert.ok(twice.canonicalBytes.equals(once.canonicalBytes));
  }
});

test('canonical bytes are the UTF-8 encoding of the canonical string', () => {
  const c = canonicalizeUrl('/a?b=%41');
  assert.ok(c.canonicalBytes.equals(Buffer.from(c.canonical, 'utf8')));
});

test('every normalization returns equivalence derivation steps', () => {
  const c = canonicalizeUrl('/a/./b%63?b=2&a=1&a=2');
  const types = c.steps.map((s) => s.type);
  assert.ok(types.includes('decode-unreserved'), 'decode step recorded');
  assert.ok(types.includes('remove-dot-segment'), 'dot-segment step recorded');
  assert.ok(types.includes('sort-query-params'), 'sort step recorded');
  assert.ok(types.includes('preserve-duplicate-key'), 'duplicate step recorded');
  const dup = c.steps.find((s) => s.type === 'preserve-duplicate-key');
  assert.deepEqual(dup?.data, { key: 'a', count: 2 });
  for (const s of c.steps) assert.ok(typeof s.message === 'string' && s.message.length > 0);
});
