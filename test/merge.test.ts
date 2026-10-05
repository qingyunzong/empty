import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MergedState, Repo } from '../src/repo.js';
import { quantile, toSortedArray } from '../src/window.js';
import { quantileRank } from '../src/quantile.js';

const P_SWEEP: [number, number][] = [
  [0, 1],
  [1, 10],
  [1, 4],
  [1, 3],
  [1, 2],
  [2, 3],
  [3, 4],
  [9, 10],
  [1, 1],
];

/** Build a base version: capacity 10, events 1..8 with the given values. */
function baseRepo(values: number[]): { repo: Repo; base: number } {
  const repo = new Repo();
  let v = repo.createWindow(10);
  values.forEach((value, i) => {
    v = repo.addEvent(v, i + 1, value);
  });
  return { repo, base: v };
}

/**
 * Independent check: enumerate every combination of the two sides' choices
 * for the open conflicts, sort each resulting multiset plainly, and derive
 * the exact min/max of every quantile rank and every probed value rank.
 */
function enumerateResolutions(merged: MergedState): number[][] {
  const certain = merged.certainValues();
  const combos: number[][] = [];
  const k = merged.conflicts.length;
  for (let mask = 0; mask < 1 << k; mask++) {
    const values = [...certain];
    merged.conflicts.forEach((conflict, i) => {
      values.push(mask & (1 << i) ? conflict.right : conflict.left);
    });
    values.sort((a, b) => a - b);
    combos.push(values);
  }
  return combos;
}

function countLessIn(sorted: number[], value: number): number {
  let n = 0;
  while (n < sorted.length && sorted[n] < value) n++;
  return n;
}

function checkBoundsAgainstEnumeration(merged: MergedState, probes: number[]): void {
  const combos = enumerateResolutions(merged);
  const n = merged.size();
  for (const [num, den] of P_SWEEP) {
    const bounds = merged.quantileBounds(num, den)!;
    assert.equal(bounds.n, n);
    assert.equal(bounds.rank, quantileRank(num, den, n));
    const values = combos.map((sorted) => sorted[bounds.rank - 1]);
    assert.equal(bounds.lower, Math.min(...values), `p=${num}/${den} lower`);
    assert.equal(bounds.upper, Math.max(...values), `p=${num}/${den} upper`);
    assert.equal(bounds.certain, bounds.lower === bounds.upper);
  }
  for (const probe of probes) {
    const bounds = merged.rankBounds(probe);
    const ranks = combos.map((sorted) => countLessIn(sorted, probe) + 1);
    assert.equal(bounds.lower, Math.min(...ranks), `rank(${probe}) lower`);
    assert.equal(bounds.upper, Math.max(...ranks), `rank(${probe}) upper`);
    assert.equal(bounds.certain, bounds.lower === bounds.upper);
  }
}

test('clean merge: disjoint corrections combine without conflicts', () => {
  const { repo, base } = baseRepo([5, 9, 1, 7, 3, 8, 2, 6]);
  repo.fork('L', base);
  repo.fork('R', base);
  repo.correctOnBranch('L', 2, 40); // event 2: 9 -> 40
  repo.correctOnBranch('R', 6, 0); // event 6: 8 -> 0
  const merged = repo.merge('L', 'R');
  assert.equal(merged.conflicts.length, 0);
  assert.deepEqual([...merged.agreed.entries()].sort((a, b) => a[0] - b[0]), [
    [2, 40],
    [6, 0],
  ]);
  // Every quantile is certain and matches the plainly merged model.
  const expected = [5, 40, 1, 7, 3, 0, 2, 6].sort((a, b) => a - b);
  for (const [num, den] of P_SWEEP) {
    const bounds = merged.quantileBounds(num, den)!;
    assert.ok(bounds.certain);
    assert.equal(bounds.lower, expected[bounds.rank - 1]);
  }
  const version = merged.resolve(); // no conflicts: publishes directly
  assert.deepEqual(toSortedArray(repo.snapshot(version)), expected);
});

test('identical corrections on both sides are not a conflict', () => {
  const { repo, base } = baseRepo([5, 9, 1, 7, 3, 8, 2, 6]);
  repo.fork('L', base);
  repo.fork('R', base);
  repo.correctOnBranch('L', 4, 100);
  repo.correctOnBranch('R', 4, 100);
  const merged = repo.merge('L', 'R');
  assert.equal(merged.conflicts.length, 0);
  assert.equal(merged.agreed.get(4), 100);
  assert.equal(merged.quantileBounds(1, 1)!.lower, 100);
});

test('conflicting corrections of the same event produce rank bounds', () => {
  const { repo, base } = baseRepo([10, 20, 30, 40, 50, 60, 70, 80]);
  repo.fork('L', base);
  repo.fork('R', base);
  repo.correctOnBranch('L', 4, 15); // 40 -> 15 on the left
  repo.correctOnBranch('R', 4, 75); // 40 -> 75 on the right
  const merged = repo.merge('L', 'R');
  assert.deepEqual(merged.conflicts, [{ eventId: 4, base: 40, left: 15, right: 75 }]);
  assert.deepEqual(merged.certainValues(), [10, 20, 30, 50, 60, 70, 80]);

  // Certain part: extreme ranks are unaffected by an interior conflict.
  const min = merged.quantileBounds(0, 1)!;
  assert.ok(min.certain);
  assert.equal(min.lower, 10);
  const max = merged.quantileBounds(1, 1)!;
  assert.ok(max.certain);
  assert.equal(max.lower, 80);

  // Uncertain part: the median rank straddles the two choices.
  const mid = merged.quantileBounds(1, 2)!; // rank ceil(8/2) = 4
  assert.equal(mid.rank, 4);
  assert.equal(mid.certain, false);
  assert.equal(mid.lower, 30); // ... 20, 30 | 15 -> sorted: 10,15,20,30,...
  assert.equal(mid.upper, 50); // ... 30, 50 | 75 -> sorted: 10,20,30,50,...

  // Rank bounds of a probed value between the two choices.
  const rankOf60 = merged.rankBounds(60);
  assert.deepEqual(
    { lower: rankOf60.lower, upper: rankOf60.upper, certain: rankOf60.certain },
    { lower: 5, upper: 6, certain: false },
  );

  // Full independent enumeration of both sides' choices for every bound.
  checkBoundsAgainstEnumeration(merged, [5, 15, 40, 60, 75, 90]);
});

test('multiple conflicts: enumerate all 2^k choice combinations', () => {
  const { repo, base } = baseRepo([11, 22, 33, 44, 55, 66, 77, 88]);
  repo.fork('L', base);
  repo.fork('R', base);
  // Three events corrected differently on the two sides -> 3 conflicts.
  repo.correctOnBranch('L', 1, 90);
  repo.correctOnBranch('R', 1, 5);
  repo.correctOnBranch('L', 5, 1);
  repo.correctOnBranch('R', 5, 99);
  repo.correctOnBranch('L', 8, 40);
  repo.correctOnBranch('R', 8, 60);
  // One agreed correction (same on both sides) and one one-sided correction.
  repo.correctOnBranch('L', 3, 35);
  repo.correctOnBranch('R', 3, 35);
  repo.correctOnBranch('R', 6, 61);
  const merged = repo.merge('L', 'R');
  assert.equal(merged.conflicts.length, 3);
  assert.equal(merged.agreed.get(3), 35);
  assert.equal(merged.agreed.get(6), 61);
  assert.deepEqual(merged.certainValues(), [22, 35, 44, 61, 77]);
  assert.equal(merged.size(), 8);
  // Independent enumeration of all 8 combinations checks every rank bound.
  checkBoundsAgainstEnumeration(merged, [1, 5, 35, 44, 60, 61, 90, 99]);
});

test('resolution publishes atomically; old snapshots stay readable', () => {
  const { repo, base } = baseRepo([10, 20, 30, 40, 50, 60, 70, 80]);
  repo.fork('L', base);
  repo.fork('R', base);
  repo.correctOnBranch('L', 2, 25);
  repo.correctOnBranch('R', 2, 65);
  repo.correctOnBranch('L', 7, 7);
  repo.correctOnBranch('R', 7, 77);
  const merged = repo.merge('L', 'R');
  assert.equal(merged.conflicts.length, 2);

  // Snapshot the conflicted view before resolving.
  const boundsBefore = P_SWEEP.map(([n, d]) => merged.quantileBounds(n, d));
  const baseSortedBefore = toSortedArray(repo.snapshot(base));
  const versionsBefore = repo.versionCount;

  // Resolving partially must fail: nothing is published.
  assert.throws(() => merged.resolve(new Map<number, 'left' | 'right'>([[2, 'left']])));
  assert.equal(repo.versionCount, versionsBefore);

  // Atomic resolution: one new version appears, fully resolved.
  const resolved = merged.resolve(
    new Map<number, 'left' | 'right'>([
      [2, 'left'], // take 25
      [7, 'right'], // take 77
    ]),
  );
  assert.equal(repo.versionCount, versionsBefore + 1);
  assert.deepEqual(toSortedArray(repo.snapshot(resolved)), [10, 25, 30, 40, 50, 60, 77, 80]);
  assert.equal(quantile(repo.snapshot(resolved), 1, 2), 40);

  // Old snapshots are still readable and unchanged.
  assert.deepEqual(toSortedArray(repo.snapshot(base)), baseSortedBefore);
  assert.equal(quantile(repo.snapshot(base), 1, 1), 80);
  // The conflicted view still reports the same bounds after resolution.
  P_SWEEP.forEach(([n, d], i) => {
    assert.deepEqual(merged.quantileBounds(n, d), boundsBefore[i]);
  });

  // Resolving the other way yields the other side's values.
  const resolvedOther = merged.resolve(
    new Map<number, 'left' | 'right'>([
      [2, 'right'],
      [7, 'left'],
    ]),
  );
  assert.deepEqual(toSortedArray(repo.snapshot(resolvedOther)), [7, 10, 30, 40, 50, 60, 65, 80]);
});

test('branches are independently queryable before merging', () => {
  const { repo, base } = baseRepo([4, 8, 15, 16, 23, 42, 8, 15]);
  repo.fork('L', base);
  repo.fork('R', base);
  repo.correctOnBranch('L', 3, 100);
  repo.correctOnBranch('R', 3, 0);
  assert.deepEqual(toSortedArray(repo.branchState('L')), [4, 8, 8, 15, 16, 23, 42, 100]);
  assert.deepEqual(toSortedArray(repo.branchState('R')), [0, 4, 8, 8, 15, 16, 23, 42]);
  // Base version is unaffected by branch corrections.
  assert.deepEqual(toSortedArray(repo.snapshot(base)), [4, 8, 8, 15, 15, 16, 23, 42]);
  // Correcting an event outside the window is rejected.
  assert.throws(() => repo.correctOnBranch('L', 99, 1));
  // Merging branches of different bases is rejected.
  const other = repo.createWindow(4);
  repo.fork('X', other);
  assert.throws(() => repo.merge('L', 'X'));
});
