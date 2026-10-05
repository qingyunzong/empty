import { test } from "node:test";
import assert from "node:assert/strict";
import { optimalSchedule, exhaustiveMinPeak, simulate, memoryBounds, checkAcyclic } from "../src/schedule";
import { mulberry32, randInt } from "./helpers";

test("schedule: chain forces order and peak", () => {
  // p0 <- p1 <- p2; dictionaries of the whole chain pile up until the end.
  const bytes = [4, 3, 2];
  const dict = [5, 6, 7];
  const deps = [[], [0], [0, 1]];
  const s = optimalSchedule(bytes, dict, deps);
  assert.deepEqual(s.order, [0, 1, 2]);
  // decode p2: resident dicts 5+6, plus bytes 2 + dict 7
  assert.equal(s.peak, 5 + 6 + 2 + 7);
  assert.equal(s.lowerBound, 5 + 6 + 2 + 7); // tight on this instance
});

test("schedule: DP picks the order that frees big dictionaries early", () => {
  // a (big dict) feeds only x; b (big dict) feeds only y. Decoding x right
  // after a frees a's dictionary before b is downloaded.
  const bytes = [10, 1, 10, 1];
  const dict = [50, 0, 40, 0];
  const deps = [[], [0], [], [2]];
  const s = optimalSchedule(bytes, dict, deps);
  assert.equal(s.peak, exhaustiveMinPeak(bytes, dict, deps));
  // Interleaving pairs keeps at most one big dictionary resident:
  // peak = 10 + 50 (decode a) then x frees it; same for b -> peak 60, not 60+40.
  assert.equal(s.peak, 60);
});

test("schedule: cycle detection", () => {
  assert.throws(() => checkAcyclic([[1], [0]]), /cycle/);
  assert.throws(() => optimalSchedule([1, 1], [1, 1], [[1], [0]]) , /cycle/);
});

test("schedule: bounds are valid on a hand-checked instance", () => {
  const bytes = [8, 5, 3];
  const dict = [4, 9, 2];
  const deps = [[], [], [0, 1]];
  const { lower, upper } = memoryBounds(bytes, dict, deps);
  assert.equal(lower, 3 + 2 + 4 + 9); // decode p2 needs both dictionaries
  assert.equal(upper, 4 + 9 + 2 + 8); // all dicts + largest download
  const s = optimalSchedule(bytes, dict, deps);
  assert.ok(s.peak >= lower && s.peak <= upper);
});

test("schedule: DP matches exhaustive state-graph enumeration on random DAGs", () => {
  const rng = mulberry32(1234567);
  for (let iter = 0; iter < 250; iter++) {
    const n = randInt(rng, 1, 8);
    const bytes: number[] = [];
    const dict: number[] = [];
    const deps: number[][] = [];
    for (let i = 0; i < n; i++) {
      bytes.push(randInt(rng, 1, 12));
      dict.push(randInt(rng, 0, 10));
      const ds: number[] = [];
      for (let j = 0; j < i; j++) if (rng() < 0.35) ds.push(j);
      deps.push(ds);
    }
    const s = optimalSchedule(bytes, dict, deps);
    const exhaustive = exhaustiveMinPeak(bytes, dict, deps)!;
    assert.equal(s.peak, exhaustive, `peak mismatch at iter ${iter}`);
    assert.ok(s.lowerBound <= s.peak, `lower bound violated at iter ${iter}`);
    assert.ok(s.peak <= s.upperBound, `upper bound violated at iter ${iter}`);
    // The certificate's own steps reproduce the reported peak and never go negative.
    let recomputed = 0;
    for (const st of s.steps) {
      assert.ok(st.memStart >= 0 && st.memAfterRelease >= 0);
      recomputed = Math.max(recomputed, st.memPeak);
    }
    assert.equal(recomputed, s.peak);
    // Dependencies are always decoded before their dependents.
    const pos = new Map(s.order.map((p, i) => [p, i]));
    for (let p = 0; p < n; p++) for (const d of deps[p]!) assert.ok(pos.get(d)! < pos.get(p)!);
  }
});

test("simulate: rejects an order that decodes before its dependency", () => {
  assert.throws(() => simulate([1, 0], [1, 1], [1, 1], [[], [0]]), /without dictionary/);
});
