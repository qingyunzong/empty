import test from "node:test";
import assert from "node:assert/strict";
import { rational, Rational, quantileRank } from "../src/rational.js";
import {
  StatsStore,
  MergedView,
  isMergedView,
  mergeWindows,
  RankBounds,
  QuantileBounds,
} from "../src/branch.js";
import {
  WindowState,
  createWindow,
  addEvent,
  correctEvent,
  quantile as windowQuantile,
  rankOf as windowRankOf,
  toSortedArray,
} from "../src/window.js";

/** Build a store whose "main" branch holds events 1..10 with given values. */
function setupStore(values: number[]): StatsStore {
  const store = new StatsStore();
  store.createWindowBranch("main", 10);
  values.forEach((v, i) => store.addEvent("main", i + 1, v));
  return store;
}

const BASE_VALUES = [4, 8, 15, 16, 23, 42, 8, 15, 4, 23]; // duplicates included

function asBounds(rank: number | RankBounds): RankBounds {
  assert.notEqual(typeof rank, "number", "expected unresolved bounds");
  return rank as RankBounds;
}

function asQBounds(q: number | null | QuantileBounds): QuantileBounds {
  assert.equal(typeof q, "object", "expected unresolved quantile bounds");
  return q as QuantileBounds;
}

test("merge: one-sided and agreed corrections are certain; divergent ones conflict", () => {
  const store = setupStore(BASE_VALUES);
  store.fork("A", "main");
  store.fork("B", "main");

  store.correctEvent("A", 3, 100); // A only -> certain
  store.correctEvent("A", 4, 16); // A: 16 -> 16 (no-op)
  store.correctEvent("B", 5, 0); // B only -> certain
  store.correctEvent("A", 6, 50); // both sides, same value -> certain
  store.correctEvent("B", 6, 50);
  store.correctEvent("A", 7, 999); // both sides, different -> conflict
  store.correctEvent("B", 7, -999);

  const merged = store.merge("M", "A", "B");
  const view = merged.state;
  assert.ok(isMergedView(view));
  assert.deepEqual(
    view.conflicts.map((c) => ({ id: c.id, left: c.leftValue, right: c.rightValue })),
    [{ id: 7, left: 999, right: -999 }],
  );
  // Certain corrections are already reflected in the certain index.
  const certain = toSortedArray({ capacity: 10, root: view.certainRoot, queue: [], values: new Map() });
  assert.deepEqual(certain, [0, 4, 4, 8, 15, 16, 23, 50, 100]);
  assert.equal(view.size, 10);
});

test("unresolved merge: rank bounds verified by independently enumerating both choices", () => {
  const store = setupStore(BASE_VALUES);
  store.fork("A", "main");
  store.fork("B", "main");
  store.correctEvent("A", 3, 100);
  store.correctEvent("B", 5, 0);
  store.correctEvent("A", 7, 999);
  store.correctEvent("B", 7, -999);
  store.merge("M", "A", "B");

  const view = store.snapshot("M");
  assert.ok(isMergedView(view));
  const resolutions = view.enumerateResolutions();
  assert.equal(resolutions.length, 2);

  // Sweep query values across and around every interesting point.
  const probes = [-1000, -999, -1, 0, 3, 4, 5, 8, 15, 16, 23, 42, 100, 998, 999, 1000];
  for (const x of probes) {
    const bounds = asBounds(store.rankOf("M", x));
    const actual = resolutions.map((r) => windowRankOf(r, x));
    // Every enumerated resolution lies inside the reported bounds...
    for (const a of actual) {
      assert.ok(a >= bounds.low && a <= bounds.high, `rankOf(${x})=${a} within [${bounds.low},${bounds.high}]`);
    }
    // ...and the bounds are tight: each side is attained by some choice.
    assert.ok(actual.includes(bounds.low), `low bound attained for x=${x}`);
    assert.ok(actual.includes(bounds.high), `high bound attained for x=${x}`);
    // The certain part never overcounts.
    assert.ok(bounds.certain <= bounds.low);
  }

  // Quantile bounds likewise match the enumerated extremes for a p-grid.
  const grid: Rational[] = [
    rational(0, 1),
    rational(1, 10),
    rational(1, 3),
    rational(1, 2),
    rational(2, 3),
    rational(9, 10),
    rational(1, 1),
  ];
  for (const p of grid) {
    const bounds = asQBounds(store.quantile("M", p));
    const actual = resolutions.map((r) => windowQuantile(r, p) as number);
    assert.equal(bounds.low, Math.min(...actual), `quantile low at p=${p.num}/${p.den}`);
    assert.equal(bounds.high, Math.max(...actual), `quantile high at p=${p.num}/${p.den}`);
    // Rank used internally must be the resolution-independent ceil(p*n).
    assert.equal(quantileRank(p, 10) >= 1, true);
  }
});

test("two conflicts: every rank bound checked against all four enumerated resolutions", () => {
  const store = setupStore(BASE_VALUES);
  store.fork("A", "main");
  store.fork("B", "main");
  store.correctEvent("A", 1, 40);
  store.correctEvent("B", 1, -40);
  store.correctEvent("A", 9, 17);
  store.correctEvent("B", 9, -17);
  store.merge("M", "A", "B");

  const view = store.snapshot("M");
  assert.ok(isMergedView(view));
  assert.equal(view.conflicts.length, 2);
  const resolutions = view.enumerateResolutions();
  assert.equal(resolutions.length, 4);

  for (let x = -45; x <= 45; x += 5) {
    const bounds = asBounds(store.rankOf("M", x));
    const actual = resolutions.map((r) => windowRankOf(r, x));
    for (const a of actual) {
      assert.ok(a >= bounds.low && a <= bounds.high, `x=${x}`);
    }
    assert.equal(bounds.low, Math.min(...actual), `tight low at x=${x}`);
    assert.equal(bounds.high, Math.max(...actual), `tight high at x=${x}`);
  }

  for (const num of [0, 1, 1, 1, 2, 3, 1]) {
    for (const den of [1, 4, 3, 2, 3, 4, 1]) {
      if (num > den) continue;
      const p = rational(num, den);
      const bounds = asQBounds(store.quantile("M", p));
      const actual = resolutions.map((r) => windowQuantile(r, p) as number);
      assert.equal(bounds.low, Math.min(...actual), `q low p=${num}/${den}`);
      assert.equal(bounds.high, Math.max(...actual), `q high p=${num}/${den}`);
    }
  }
});

test("conflict resolution is an atomic publish; old snapshots stay readable", () => {
  const store = setupStore(BASE_VALUES);
  store.fork("A", "main");
  store.fork("B", "main");
  store.correctEvent("A", 2, 11);
  store.correctEvent("A", 8, 90);
  store.correctEvent("B", 8, -90);
  store.merge("M", "A", "B");

  const branch = store.getBranch("M");
  const versionBefore = branch.version;
  const unresolvedSnap = store.snapshot("M"); // MergedView, taken pre-resolution
  assert.ok(isMergedView(unresolvedSnap));
  const boundsBefore = unresolvedSnap.rankOfBounds(0);

  // Atomically publish the resolution choosing side B's value for event 8.
  store.resolveConflict("M", 8, "right");

  assert.equal(branch.version, versionBefore + 1);
  const resolved = store.snapshot("M");
  assert.ok(!isMergedView(resolved));
  assert.deepEqual(toSortedArray(resolved as WindowState), [-90, 4, 4, 8, 11, 15, 16, 23, 23, 42]);

  // Queries on the resolved branch are plain values again.
  assert.equal(store.quantile("M", rational(0, 1)), -90);
  assert.equal(store.quantile("M", rational(1, 1)), 42);
  assert.equal(store.quantile("M", rational(1, 2)), 11);
  assert.equal(store.rankOf("M", 12), 5);

  // The pre-resolution snapshot is untouched and still answers with bounds.
  assert.ok(isMergedView(unresolvedSnap));
  assert.deepEqual(unresolvedSnap.rankOfBounds(0), boundsBefore);
  assert.deepEqual(unresolvedSnap.rankOfBounds(0), { certain: 0, low: 0, high: 1 });
  assert.deepEqual(unresolvedSnap.quantileBounds(rational(0, 1)), { low: -90, high: 4 });

  // The resolved state equals the matching enumerated resolution exactly.
  const enumerated = unresolvedSnap
    .enumerateResolutions()
    .map((r) => toSortedArray(r));
  assert.ok(enumerated.some((s) => s.join() === toSortedArray(resolved as WindowState).join()));

  // Source branches are also untouched by the merge and resolution.
  assert.deepEqual(
    toSortedArray(store.snapshot("A") as WindowState),
    [4, 8, 11, 15, 16, 23, 42, 90, 4, 23].sort((a, b) => a - b),
  );
});

test("stepwise resolution of multiple conflicts publishes intermediate views", () => {
  const store = setupStore(BASE_VALUES);
  store.fork("A", "main");
  store.fork("B", "main");
  store.correctEvent("A", 1, 40);
  store.correctEvent("B", 1, -40);
  store.correctEvent("A", 9, 17);
  store.correctEvent("B", 9, -17);
  const merged = store.merge("M", "A", "B");
  const v0 = merged.version;

  store.resolveConflict("M", 1, "left"); // one conflict remains
  assert.equal(merged.version, v0 + 1);
  const mid = store.snapshot("M");
  assert.ok(isMergedView(mid));
  assert.equal(mid.conflicts.length, 1);
  assert.equal(mid.conflictFor(9)?.leftValue, 17);
  // Event 1 is now certain at 40.
  assert.deepEqual(mid.rankOfBounds(40).certain >= 1, true);

  store.resolveConflict("M", 9, "right"); // last conflict -> resolved window
  assert.equal(merged.version, v0 + 2);
  const finalState = store.snapshot("M");
  assert.ok(!isMergedView(finalState));
  assert.deepEqual(
    toSortedArray(finalState as WindowState),
    [-17, 8, 8, 15, 15, 16, 23, 23, 40, 42],
  );
});

test("merge without conflicts publishes a resolved window directly", () => {
  const store = setupStore(BASE_VALUES);
  store.fork("A", "main");
  store.fork("B", "main");
  store.correctEvent("A", 2, 9);
  store.correctEvent("B", 4, 9);
  store.merge("M", "A", "B");
  const state = store.snapshot("M");
  assert.ok(!isMergedView(state));
  assert.deepEqual(
    toSortedArray(state as WindowState),
    [4, 9, 15, 9, 23, 42, 8, 15, 4, 23].sort((a, b) => a - b),
  );
});

test("merge rejects branches that added/evicted events since the fork", () => {
  const store = new StatsStore();
  store.createWindowBranch("main", 3);
  store.addEvent("main", 1, 1);
  store.fork("A", "main");
  store.fork("B", "main");
  assert.throws(() => store.addEvent("A", 2, 2), /only accepts corrections/);
  // The root branch can still add, but it has no shared fork point with the
  // forks, so it can never be merged with them.
  store.addEvent("main", 2, 2);
  store.correctEvent("B", 1, 5);
  assert.throws(() => store.merge("M", "main", "B"), /do not share a fork point/);
  assert.throws(() => store.merge("M2", "A", "main"), /do not share a fork point/);
});

test("mergeWindows guard: adds/evictions since the base are not mergeable", () => {
  let base = createWindow(3);
  base = addEvent(base, 1, 10);
  base = addEvent(base, 2, 20);
  const corrected = correctEvent(base, 1, 99);
  const added = addEvent(base, 3, 30); // live queue diverges from base
  assert.throws(() => mergeWindows(base, corrected, added), /only corrections are mergeable/);
  assert.throws(() => mergeWindows(base, added, corrected), /only corrections are mergeable/);
  // A clean correction-only divergence merges and conflicts as expected.
  const view = mergeWindows(base, correctEvent(base, 1, 100), correctEvent(base, 1, -100));
  assert.ok(isMergedView(view));
  assert.deepEqual(
    view.conflicts.map((c) => c.id),
    [1],
  );
});

test("merge requires a shared fork point and resolved inputs", () => {
  const store = setupStore(BASE_VALUES);
  const other = new StatsStore();
  other.createWindowBranch("x", 10);
  store.fork("A", "main");
  assert.throws(() => store.merge("M", "A", "nope"), /unknown branch/);
  store.fork("B", "main");
  store.correctEvent("A", 1, 2);
  store.correctEvent("B", 1, 3);
  store.merge("M", "A", "B");
  assert.throws(() => store.fork("C", "M"), /unresolved conflicts/);
  assert.throws(() => store.correctEvent("M", 2, 5), /resolve them first/);
  assert.throws(() => store.resolveConflict("A", 1, "left"), /no unresolved conflicts/);
});
