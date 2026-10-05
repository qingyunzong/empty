import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { normalizeRecord } from '../src/record.js';

function corr(site, time, delta, origin, seq) {
  return normalizeRecord({ type: 'correction', site, time, delta, origin, seq });
}

function dump(records) {
  const store = new Store();
  for (const r of records) store.add(r);
  return store.toJsonl();
}

function* permutations(arr) {
  const a = arr.slice();
  const n = a.length;
  const c = new Array(n).fill(0);
  yield a.slice();
  let i = 0;
  while (i < n) {
    if (c[i] < i) {
      const j = i % 2 === 0 ? 0 : c[i];
      [a[i], a[j]] = [a[j], a[i]];
      c[i] += 1;
      i = 0;
      yield a.slice();
    } else {
      c[i] = 0;
      i += 1;
    }
  }
}

// Commutativity: every permutation of records from n <= 8 origins merges to
// the same canonical store. Origins collide on (site, time) keys so conflict
// resolution is exercised. Sum over n of n! = 46233 merges.
test('merge is commutative for all permutations of <= 8 sites', () => {
  for (let n = 1; n <= 8; n++) {
    const records = [];
    for (let i = 0; i < n; i++) {
      records.push(corr(`S${i % 2}`, '2026-01-01T00:00:00Z', i - 3, `O${i}`, i + 1));
    }
    const reference = dump(records);
    let count = 0;
    for (const perm of permutations(records)) {
      assert.equal(dump(perm), reference, `permutation mismatch at n=${n}`);
      count += 1;
    }
    assert.equal(count, factorial(n));
  }
});

function factorial(n) {
  return n <= 1 ? 1 : n * factorial(n - 1);
}

test('merge is commutative over permutations including tombstones', () => {
  const base = [
    normalizeRecord({ type: 'site', site: 'A', op: 'register', origin: 'O1', seq: 1 }),
    normalizeRecord({ type: 'site', site: 'A', op: 'delete', origin: 'O1', seq: 5 }),
    normalizeRecord({ type: 'site', site: 'A', op: 'register', origin: 'O2', seq: 3 }),
    corr('A', '2026-01-01T00:00:00Z', 1.5, 'O1', 2),
    corr('A', '2026-01-01T00:00:00Z', -4, 'O2', 4),
    corr('A', '2026-01-02T00:00:00Z', 0.5, 'O2', 6),
  ];
  const reference = dump(base);
  for (const perm of permutations(base)) {
    assert.equal(dump(perm), reference);
  }
});

function mergeDumps(...dumps) {
  const store = new Store();
  for (const d of dumps) {
    for (const line of d.split('\n')) {
      if (line.trim() !== '') store.add(normalizeRecord(JSON.parse(line)));
    }
  }
  return store.toJsonl();
}

// Deterministic pseudo-random record batches.
function batch(seed, size) {
  let s = seed;
  const rand = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s;
  };
  const records = [];
  for (let i = 0; i < size; i++) {
    records.push(corr(
      `S${rand() % 4}`,
      `2026-01-0${1 + (rand() % 3)}T00:00:00Z`,
      (rand() % 400) / 10 - 20,
      `O${rand() % 5}`,
      rand() % 10,
    ));
  }
  return records;
}

test('merge is associative', () => {
  for (let trial = 0; trial < 100; trial++) {
    const a = dump(batch(trial * 3 + 1, 6));
    const b = dump(batch(trial * 3 + 2, 6));
    const c = dump(batch(trial * 3 + 3, 6));
    assert.equal(mergeDumps(mergeDumps(a, b), c), mergeDumps(a, mergeDumps(b, c)));
  }
});

test('merge is idempotent', () => {
  for (let trial = 0; trial < 100; trial++) {
    const x = dump(batch(trial * 2 + 1, 8));
    const y = dump(batch(trial * 2 + 2, 8));
    assert.equal(mergeDumps(x, x), x);
    assert.equal(mergeDumps(x, mergeDumps(x, y)), mergeDumps(x, y));
    assert.equal(mergeDumps(mergeDumps(x, y), y), mergeDumps(x, y));
  }
});
