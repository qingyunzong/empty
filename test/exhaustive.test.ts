import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCacheKey, type RawRequest } from '../src/cacheKey.js';
import { semanticallyEquivalent } from './semantics.js';

/**
 * Exhaustive collision check over a small request space.
 *
 * Every combination of the alphabets below is keyed. Then, for ALL pairs:
 *   - same key  => the independent oracle must judge them equivalent
 *     (no collisions: distinct semantics never share a key);
 *   - different keys => the oracle must judge them non-equivalent
 *     (no fragmentation: equivalent requests never get distinct keys).
 *
 * Pairs are checked via key groups so the O(n^2) oracle work only happens
 * between group representatives.
 */

const KEY_HEADERS = ['accept', 'x-mode', 'cookie'] as const;
const OPTS = { keyHeaders: KEY_HEADERS } as const;

const METHODS = ['GET', 'get', 'Post'];

const PATHS = [
  '/',
  '/a',
  '/a/',
  '/a/b',
  '/a//b',
  '/a/./b',
  '/a/c/../b',
  '/a/b/..',
  '/%61/b',
  '/a/%62',
  '/a/%2F/b',
  '/~x',
  '/%7Ex',
  '/a/b/c/../../d',
];

const QUERIES = ['', '?x=1', '?x=%31', '?x=1&y=2', '?y=2&x=1'];

const HEADER_SETS: ReadonlyArray<ReadonlyArray<readonly [string, string]>> = [
  [],
  [['Accept', 'a']],
  [['accept', ' a ']],
  [['accept', 'a,b']],
  [['accept', 'a, b']],
  [['accept', 'a'], ['Accept', 'b']],
  [['accept', 'b'], ['accept', 'a']],
  [['accept', '"a, b"']],
  [['accept', 'a,,b']],
  [['accept', 'a'], ['x-mode', '1']],
  [['x-mode', '1'], ['accept', 'a']],
  [['x-mode', ' 1\t']],
  [['cookie', 'a=1; b=2']],
  [['cookie', 'a=1'], ['cookie', 'b=2']],
  [['cookie', 'a=1 ;b=2']],
  [['cookie', 'b=2'], ['cookie', 'a=1']],
  [['x-extra', 'ignored']],
  [['accept', 'a'], ['x-extra', '1'], ['X-Extra', '2']],
  [['accept', 'a'], ['cookie', 'a=1'], ['x-extra', 'z']],
  [['ACCEPT', 'a,  b'], ['x-mode', '1'], ['cookie', 'a=1;  b=2']],
];

function generateRequests(): RawRequest[] {
  const seen = new Set<string>();
  const requests: RawRequest[] = [];
  for (const method of METHODS) {
    for (const path of PATHS) {
      for (const query of QUERIES) {
        for (const headers of HEADER_SETS) {
          const req: RawRequest = { method, target: path + query, headers };
          const fingerprint = JSON.stringify([method, path + query, headers]);
          if (seen.has(fingerprint)) continue;
          seen.add(fingerprint);
          requests.push(req);
        }
      }
    }
  }
  return requests;
}

test('exhaustive: equal keys iff semantically equivalent (no collisions, no fragmentation)', () => {
  const requests = generateRequests();
  assert.ok(requests.length > 1000, `expected a large space, got ${requests.length}`);

  const results = requests.map((req) => buildCacheKey(req, OPTS));

  const groups = new Map<string, number[]>();
  results.forEach((result, index) => {
    const members = groups.get(result.key);
    if (members) members.push(index);
    else groups.set(result.key, [index]);
  });

  // Sanity: normalization must actually merge variants into shared keys.
  assert.ok(groups.size < requests.length, 'expected normalization to merge some requests');

  // Within a key group: every member must be semantically equivalent to the
  // representative. A failure here is a COLLISION (same key, different semantics).
  for (const [key, members] of groups) {
    const rep = requests[members[0]!]!;
    for (const index of members) {
      assert.ok(
        semanticallyEquivalent(rep, requests[index]!, KEY_HEADERS),
        `COLLISION: same key ${key} for semantically different requests:\n` +
          `  ${JSON.stringify(rep)}\n  ${JSON.stringify(requests[index])}`
      );
    }
  }

  // Across key groups: representatives must be pairwise non-equivalent.
  // A failure here is FRAGMENTATION (different keys, same semantics).
  const reps = [...groups.values()].map((members) => members[0]!);
  for (let i = 0; i < reps.length; i++) {
    for (let j = i + 1; j < reps.length; j++) {
      assert.ok(
        !semanticallyEquivalent(requests[reps[i]!]!, requests[reps[j]!]!, KEY_HEADERS),
        `FRAGMENTATION: semantically equivalent requests got different keys:\n` +
          `  ${JSON.stringify(requests[reps[i]!])} -> ${results[reps[i]!]!.key}\n` +
          `  ${JSON.stringify(requests[reps[j]!])} -> ${results[reps[j]!]!.key}`
      );
    }
  }

  console.log(
    `exhaustive space: ${requests.length} requests, ${groups.size} distinct keys, ` +
      `${(reps.length * (reps.length - 1)) / 2} cross-group pairs checked`
  );
});

test('exhaustive: ignored headers never change the key', () => {
  const requests = generateRequests();
  for (const req of requests) {
    const base = buildCacheKey(req, OPTS).key;
    const withIgnored = buildCacheKey(
      { ...req, headers: [...(req.headers as ReadonlyArray<readonly [string, string]>), ['x-extra', 'zzz']] },
      OPTS
    );
    assert.equal(withIgnored.key, base);
    assert.ok(withIgnored.audit.ignored.some((f) => f.name === 'x-extra' && f.value === 'zzz'));
  }
});
