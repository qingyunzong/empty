import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcile, signature, isBalanced } from '../src/reconcile.js';
import { minimize } from '../src/minimize.js';

const normal = (entryId, account, amount) => ({ entryId, account, amount, type: 'normal' });
const reversal = (entryId, account, amount, reversalOf) => ({
  entryId,
  account,
  amount,
  type: 'reversal',
  reversalOf,
});

function keysOf(result) {
  const keys = [
    ...result.minimalExpected.map((e) => 'E:' + e.entryId),
    ...result.minimalActual.map((e) => 'A:' + e.entryId),
  ];
  return keys.sort();
}

// Independent brute-force minimizer used only for cross-checking: enumerates
// every subset of the combined input and keeps the cardinality-minimal,
// lexicographically-smallest one whose diff signature matches the full input.
function bruteForce(expected, actual) {
  const target = signature(reconcile(expected, actual));
  const universe = [
    ...expected.map((e) => 'E:' + e.entryId),
    ...actual.map((e) => 'A:' + e.entryId),
  ];
  const byKey = new Map();
  for (const e of expected) byKey.set('E:' + e.entryId, { side: 'E', entry: e });
  for (const e of actual) byKey.set('A:' + e.entryId, { side: 'A', entry: e });

  const lexCompare = (a, b) => {
    for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
      if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    return a.length - b.length;
  };

  let best = null;
  for (let mask = 1; mask < 1 << universe.length; mask += 1) {
    const keys = universe.filter((_, i) => mask & (1 << i)).sort();
    if (best && (keys.length > best.length ||
        (keys.length === best.length && lexCompare(keys, best) >= 0))) {
      continue;
    }
    const subExpected = keys.filter((k) => k[0] === 'E').map((k) => byKey.get(k).entry);
    const subActual = keys.filter((k) => k[0] === 'A').map((k) => byKey.get(k).entry);
    if (signature(reconcile(subExpected, subActual)) === target) {
      if (!best || keys.length < best.length ||
          (keys.length === best.length && lexCompare(keys, best) < 0)) {
        best = keys;
      }
    }
  }
  return best;
}

test('balanced input yields a balanced result with empty subsets', () => {
  const result = minimize([normal('e1', 'cash', 100)], [normal('e1', 'cash', 100)]);
  assert.ok(result.balanced);
  assert.deepEqual(result.minimalExpected, []);
  assert.deepEqual(result.minimalActual, []);
});

test('missing mixed with orphan reversal locates original and reversal together', () => {
  const expected = [normal('e1', 'cash', 100)];
  const actual = [reversal('r1', 'cash', -100, 'e1')];
  const result = minimize(expected, actual);
  assert.equal(result.algorithm, 'exhaustive-lexmin');
  assert.deepEqual(keysOf(result), ['A:r1', 'E:e1']);
  assert.deepEqual(result.diffs.missing.map((e) => e.entryId), ['e1']);
  assert.deepEqual(result.diffs.invalidReversal.map((r) => r.entry.entryId), ['r1']);
  assert.equal(result.totalImpact, -200);
});

test('matched entries are excluded from the minimal subset', () => {
  const expected = [normal('ok', 'cash', 5), normal('bad', 'ar', 40)];
  const actual = [normal('ok', 'cash', 5)];
  const result = minimize(expected, actual);
  assert.deepEqual(keysOf(result), ['E:bad']);
});

test('amount mismatch keeps both sides of the pair', () => {
  const result = minimize([normal('e1', 'cash', 100)], [normal('e1', 'cash', 120)]);
  assert.deepEqual(keysOf(result), ['A:e1', 'E:e1']);
});

test('every independent error appears in the minimal subset', () => {
  const expected = [];
  const actual = [normal('b', 'cash', 10), normal('a', 'cash', 10)];
  const result = minimize(expected, actual);
  // Both extras are needed to reproduce the full signature.
  assert.deepEqual(keysOf(result), ['A:a', 'A:b']);
});

test('cross-check against independent subset enumeration for <=4 entries', () => {
  // Deterministic PRNG.
  let state = 0x2f6e2b1;
  const rng = () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];

  const ids = ['e1', 'e2', 'e3'];
  const accounts = ['cash', 'ar'];
  const amounts = [0, 50, 100];

  let checked = 0;
  for (let iter = 0; iter < 400 && checked < 150; iter += 1) {
    const buildSide = () => {
      const side = [];
      const count = Math.floor(rng() * 3); // 0..2 entries per side
      const used = new Set();
      for (let i = 0; i < count; i += 1) {
        const id = pick(ids);
        if (used.has(id)) continue;
        used.add(id);
        const account = pick(accounts);
        if (rng() < 0.3) {
          // reversal of an existing normal entry on this side, or orphan
          const normals = side.filter((e) => e.type === 'normal');
          const target = normals.length && rng() < 0.7 ? pick(normals).entryId : pick(ids);
          const orig = side.find((e) => e.entryId === target);
          const amount = orig ? -orig.amount : -pick(amounts);
          const rid = 'r_' + id;
          if (used.has(rid)) continue;
          used.add(rid);
          side.push(reversal(rid, account, amount, target));
        } else {
          side.push(normal(id, account, pick(amounts)));
        }
      }
      return side;
    };
    const expected = buildSide();
    const actual = buildSide();
    if (expected.length + actual.length === 0 || expected.length + actual.length > 4) continue;
    checked += 1;

    const result = minimize(expected, actual);
    const fullDiffs = reconcile(expected, actual);
    if (isBalanced(fullDiffs)) {
      assert.ok(result.balanced);
      continue;
    }
    const expectedKeys = bruteForce(expected, actual);
    assert.deepEqual(
      keysOf(result),
      expectedKeys,
      `mismatch for ${JSON.stringify({ expected, actual })}`,
    );
    // The minimal subset reproduces the full diff signature exactly.
    assert.equal(
      signature(reconcile(result.minimalExpected, result.minimalActual)),
      signature(fullDiffs),
    );
  }
  assert.ok(checked >= 100, `only ${checked} cases checked`);
});

test('greedy minimizer on large input is 1-minimal and preserves the signature', () => {
  // 12 matched entries + 1 missing + 1 orphan reversal => 14 entries (> 8).
  const expected = [];
  const actual = [];
  for (let i = 0; i < 12; i += 1) {
    expected.push(normal(`ok${i}`, 'cash', i + 1));
    actual.push(normal(`ok${i}`, 'cash', i + 1));
  }
  expected.push(normal('lost', 'ar', 500));
  actual.push(reversal('orphan', 'ar', -500, 'lost'));

  const result = minimize(expected, actual);
  assert.equal(result.algorithm, 'greedy-1minimal');
  assert.deepEqual(keysOf(result), ['A:orphan', 'E:lost']);

  const target = signature(reconcile(expected, actual));
  assert.equal(signature(reconcile(result.minimalExpected, result.minimalActual)), target);

  // 1-minimality: deleting any single entry makes the error disappear.
  const all = [
    ...result.minimalExpected.map((e) => ({ side: 'E', entry: e })),
    ...result.minimalActual.map((e) => ({ side: 'A', entry: e })),
  ];
  for (const removed of all) {
    const subExpected = result.minimalExpected.filter((e) => e !== removed.entry);
    const subActual = result.minimalActual.filter((e) => e !== removed.entry);
    assert.notEqual(
      signature(reconcile(subExpected, subActual)),
      target,
      `removing ${removed.entry.entryId} should change the signature`,
    );
  }
});
