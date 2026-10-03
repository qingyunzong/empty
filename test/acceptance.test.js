import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { solveTasks } from '../src/scheduler.js';
import { ZERO, add, cmp, parseRat, rat, ratToString } from '../src/rational.js';

// ---------- brute-force reference (subset x permutation enumeration) ----------

function* permutations(arr) {
  if (arr.length <= 1) {
    yield arr.slice();
    return;
  }
  for (let i = 0; i < arr.length; i++) {
    const rest = arr.slice(0, i).concat(arr.slice(i + 1));
    for (const p of permutations(rest)) yield [arr[i], ...p];
  }
}

function feasibleSubset(sub) {
  if (sub.length === 0) return true;
  for (const perm of permutations(sub)) {
    let t = null;
    let ok = true;
    for (const job of perm) {
      const s = t === null ? job.release : cmp(t, job.release) >= 0 ? t : job.release;
      const e = add(s, job.duration);
      if (cmp(e, job.deadline) > 0) {
        ok = false;
        break;
      }
      t = e;
    }
    if (ok) return true;
  }
  return false;
}

function lexCmpIds(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

function bruteForce(tasks) {
  const n = tasks.length;
  let best = null;
  for (let mask = 0; mask < 1 << n; mask++) {
    const sub = tasks.filter((_, i) => (mask >> i) & 1);
    if (!feasibleSubset(sub)) continue;
    const weight = sub.reduce((w, t) => add(w, t.weight), ZERO);
    const ids = sub.map((t) => t.id).sort();
    if (
      !best ||
      cmp(weight, best.weight) > 0 ||
      (cmp(weight, best.weight) === 0 && lexCmpIds(ids, best.ids) < 0)
    ) {
      best = { weight, ids };
    }
  }
  return best;
}

function checkScheduleConsistent(tasks, result) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const placed = result.selected
    .map((s) => ({ ...s, startR: parseRat(s.start), endR: parseRat(s.end) }))
    .sort((a, b) => cmp(a.startR, b.startR));
  let prevEnd = null;
  for (const p of placed) {
    const t = byId.get(p.id);
    assert.ok(t, `selected unknown task ${p.id}`);
    assert.ok(cmp(p.startR, t.release) >= 0, `${p.id} starts before release`);
    assert.ok(cmp(p.endR, t.deadline) <= 0, `${p.id} ends after deadline`);
    assert.equal(ratToString(add(p.startR, t.duration)), p.end, `${p.id} end != start+duration`);
    if (prevEnd) assert.ok(cmp(p.startR, prevEnd) >= 0, `${p.id} overlaps predecessor`);
    prevEnd = p.endR;
  }
}

// ---------- acceptance 1: three overlapping tasks + randomized cross-check ----------

test('three overlapping windows match subset/permutation brute force', () => {
  const tasks = [
    { id: 'a', release: rat(0n), deadline: rat(2n), duration: rat(1n), weight: rat(3n) },
    { id: 'b', release: rat(0n), deadline: rat(3n), duration: rat(2n), weight: rat(4n) },
    { id: 'c', release: rat(1n), deadline: rat(3n), duration: rat(1n), weight: rat(2n) },
  ];
  const lib = solveTasks(tasks);
  const ref = bruteForce(tasks);
  assert.equal(lib.weight, ratToString(ref.weight));
  assert.deepEqual(
    lib.selected.map((s) => s.id).sort(),
    ref.ids
  );
  checkScheduleConsistent(tasks, lib);
});

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('randomized n<=8 instances match brute force (exact rationals)', () => {
  const rand = mulberry32(20261003);
  for (let iter = 0; iter < 30; iter++) {
    const n = 1 + Math.floor(rand() * 8);
    const tasks = [];
    for (let i = 0; i < n; i++) {
      const den = rand() < 0.5 ? 1n : 2n; // exercise non-unit fractions
      const r = BigInt(Math.floor(rand() * 4));
      const w = BigInt(1 + Math.floor(rand() * 4));
      const p = BigInt(1 + Math.floor(rand() * 3));
      tasks.push({
        id: `t${i}`,
        release: rat(r * den, den),
        deadline: rat((r + w) * den, den),
        duration: rat(p * den, den),
        weight: rat(BigInt(1 + Math.floor(rand() * 6))),
      });
    }
    const lib = solveTasks(tasks);
    const ref = bruteForce(tasks);
    assert.equal(lib.weight, ratToString(ref.weight), `weight mismatch at iter ${iter}`);
    assert.deepEqual(
      lib.selected.map((s) => s.id).sort(),
      ref.ids,
      `selection mismatch at iter ${iter}`
    );
    checkScheduleConsistent(tasks, lib);
  }
});

// ---------- acceptance 2: touching boundaries ----------

test('[0,1] and [1,2] touch and chain; update to (0,1) window breaks co-scheduling', () => {
  const s = new Store();
  s.add({ id: 'a', release: '0', deadline: '1', duration: '1', weight: '1' });
  s.add({ id: 'b', release: '1', deadline: '2', duration: '1', weight: '1' });
  let r = s.solve();
  assert.deepEqual(r.selected, [
    { id: 'a', start: '0', end: '1' },
    { id: 'b', start: '1', end: '2' },
  ]);
  assert.equal(r.weight, '2');

  // Move b's window to (0,1): both tasks now need the same unit slot.
  s.update('b', { release: '0', deadline: '1' });
  r = s.solve();
  assert.equal(r.selected.length, 1);
  assert.equal(r.weight, '1');
  assert.deepEqual(r.certificate.b ?? r.certificate.a, [r.selected[0].id]);
});

// ---------- acceptance 3: tie after update, undo/redo consistency ----------

test('update creates a tie; undo and redo restore state and certificate', () => {
  const s = new Store();
  s.add({ id: 'a', release: '0', deadline: '1', duration: '1', weight: '2' });
  s.add({ id: 'b', release: '0', deadline: '1', duration: '1', weight: '1' });
  s.add({ id: 'c', release: '2', deadline: '3', duration: '1', weight: '5' });

  const before = s.solve();
  assert.deepEqual(
    before.selected.map((x) => x.id),
    ['a', 'c']
  );
  assert.equal(before.weight, '7');
  assert.deepEqual(before.certificate, { b: ['a'] });

  s.update('b', { weight: '2' }); // now {a,c} and {b,c} both weigh 7
  const tied = s.solve();
  assert.equal(tied.weight, '7');
  assert.deepEqual(
    tied.selected.map((x) => x.id),
    ['a', 'c'],
    'tie must resolve to lexicographically smallest selected id list'
  );
  assert.deepEqual(tied.certificate, { b: ['a'] });

  s.undo();
  assert.deepEqual(s.solve(), before);
  s.redo();
  assert.deepEqual(s.solve(), tied);
});

// ---------- acceptance 4: invalid input writes no version ----------

function expectCode(fn, code) {
  try {
    fn();
  } catch (e) {
    assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    return;
  }
  assert.fail(`expected ${code}, but no error was thrown`);
}

test('invalid add/update are rejected and produce no new version', () => {
  const s = new Store();
  s.add({ id: 'a', release: '0', deadline: '2', duration: '1', weight: '1' });
  const v0 = s.version;
  const vc0 = s.versionCount;
  const state0 = s.solve();

  expectCode(
    () => s.add({ id: 'x', release: '1/0', deadline: '2', duration: '1', weight: '1' }),
    'E_RATIONAL'
  );
  expectCode(
    () => s.add({ id: 'y', release: '3', deadline: '2', duration: '1', weight: '1' }),
    'E_EMPTY'
  );
  expectCode(
    () => s.add({ id: 'z', release: '0', deadline: '2', duration: '0', weight: '1' }),
    'E_EMPTY'
  );
  expectCode(
    () => s.add({ id: 'w', release: '0', deadline: '2', duration: '-1/2', weight: '1' }),
    'E_EMPTY'
  );
  expectCode(
    () => s.add({ id: 'f', release: 0.5, deadline: '2', duration: '1', weight: '1' }),
    'E_RATIONAL'
  );
  // Invalid update must not change the current version.
  expectCode(() => s.update('a', { deadline: '0', release: '1' }), 'E_EMPTY');
  expectCode(() => s.update('a', { duration: '0' }), 'E_EMPTY');
  expectCode(() => s.update('a', { weight: '1/0' }), 'E_RATIONAL');
  expectCode(() => s.update('ghost', { weight: '2' }), 'E_NOT_FOUND');

  assert.equal(s.version, v0);
  assert.equal(s.versionCount, vc0);
  assert.deepEqual(s.solve(), state0);

  // A valid update still works afterwards and bumps the version exactly once.
  s.update('a', { weight: '3' });
  assert.equal(s.version, v0 + 1);
  assert.equal(s.solve().weight, '3');
});
