import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeUrl, matchRoute } from '../src/index.js';

const ROUTES = ['/users/{id}', '/users/{id}/posts/{pid}', '/health'];

test('independent matcher: basic routing with params', () => {
  const m = matchRoute(ROUTES, '/users/1');
  assert.deepEqual(m, { pattern: '/users/{id}', patternIndex: 0, params: { id: '1' } });
  assert.equal(matchRoute(ROUTES, '/users/1/posts/2')?.patternIndex, 1);
  assert.equal(matchRoute(ROUTES, '/nowhere'), null);
});

test('key-equivalent URLs keep identical public routing semantics', () => {
  // Each group contains URLs whose canonical forms are equal.
  const equivalentGroups = [
    ['/users/1', '/users/%31', '/users/./%31', '/a/../users/1'],
    ['/users/9/posts/2', '/users/%39/posts/%32', '/x/./../users/9/posts/2'],
    ['/health', '/%68ealth', '/./health'],
  ];
  for (const group of equivalentGroups) {
    const canonicals = group.map((u) => canonicalizeUrl(u));
    for (const c of canonicals) assert.equal(c.canonical, canonicals[0].canonical);
    const expected = matchRoute(ROUTES, canonicals[0].canonicalPath);
    assert.ok(expected, `group routes: ${group[0]}`);
    for (const c of canonicals) {
      assert.deepEqual(
        matchRoute(ROUTES, c.canonicalPath),
        expected,
        `routing changed for key-equivalent URL of ${c.raw}`,
      );
    }
  }
});

test('matcher is independent: it does not decode or remove dots itself', () => {
  // Raw (un-normalized) paths route by their literal segments, which is why
  // routing must happen on canonical paths.
  assert.equal(matchRoute(ROUTES, '/users/%31')?.params.id, '%31');
  assert.equal(matchRoute(ROUTES, '/a/../users/1'), null);
});

test('non-equivalent canonical paths may select different routes', () => {
  const a = canonicalizeUrl('/users/1');
  const b = canonicalizeUrl('/users/1/posts/2');
  assert.notEqual(a.canonical, b.canonical);
  assert.notEqual(
    matchRoute(ROUTES, a.canonicalPath)?.patternIndex,
    matchRoute(ROUTES, b.canonicalPath)?.patternIndex,
  );
});
