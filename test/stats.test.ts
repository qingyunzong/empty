import test from "node:test";
import assert from "node:assert/strict";
import { averageRanks, exactMedian, wilcoxonSignedRankExact } from "../src/stats.js";

test("exactMedian handles odd and even counts exactly", () => {
  assert.equal(exactMedian([]), null);
  assert.equal(exactMedian([7]), 7);
  assert.equal(exactMedian([3, 1, 2]), 2);
  assert.equal(exactMedian([1, 2]), 1.5);
  assert.equal(exactMedian([4, 1, 7, 2]), 3);
  assert.equal(exactMedian([-5, 5]), 0);
});

test("averageRanks assigns mean ranks to ties", () => {
  assert.deepEqual(averageRanks([10, 20, 30]), [1, 2, 3]);
  assert.deepEqual(averageRanks([5, 5, 3]), [2.5, 2.5, 1]);
  assert.deepEqual(averageRanks([2, 2, 2]), [2, 2, 2]);
  assert.deepEqual(averageRanks([4, 1, 4, 4]), [3, 1, 3, 3]);
});

test("wilcoxon drops zero differences", () => {
  const core = wilcoxonSignedRankExact([0, 0, 5]);
  assert.ok(core !== null);
  assert.equal(core.n, 1);
  assert.equal(core.wPlus, 1);
  assert.equal(core.wMinus, 0);
  assert.equal(core.pValue, 1);
  assert.equal(wilcoxonSignedRankExact([0, 0]), null);
});

test("wilcoxon exact two-sided p for all-positive n=3 is 2/8", () => {
  const core = wilcoxonSignedRankExact([1, 2, 3])!;
  assert.equal(core.n, 3);
  assert.equal(core.wPlus, 6);
  assert.equal(core.wMinus, 0);
  assert.equal(core.statistic, 6);
  assert.equal(core.extremeCount, 2n);
  assert.equal(core.totalReassignments, 8n);
  assert.equal(core.pValue, 0.25);
});

test("wilcoxon averages tied absolute ranks", () => {
  const core = wilcoxonSignedRankExact([1, -1, 2])!;
  assert.deepEqual([...core.absRanks], [1.5, 1.5, 3]);
  assert.equal(core.wPlus, 4.5);
  assert.equal(core.wMinus, 1.5);
  assert.equal(core.statistic, 3);
  assert.equal(core.extremeCount, 6n);
  assert.equal(core.totalReassignments, 8n);
  assert.equal(core.pValue, 0.75);
});

test("wilcoxon symmetric diffs give p=1", () => {
  const core = wilcoxonSignedRankExact([2, 2, -2])!;
  assert.deepEqual([...core.absRanks], [2, 2, 2]);
  assert.equal(core.pValue, 1);
});

test("wilcoxon matches brute-force enumeration for a mixed case", () => {
  const diffs = [3, -1, 4, -2, 5];
  const core = wilcoxonSignedRankExact(diffs)!;
  const absRanks = core.absRanks;
  let extreme = 0;
  const total = 1 << diffs.length;
  for (let mask = 0; mask < total; mask++) {
    let wPlus = 0;
    for (let i = 0; i < diffs.length; i++) {
      const sign = (mask >> i) & 1 ? 1 : -1;
      if (sign > 0) wPlus += absRanks[i];
    }
    const wMinus = 15 - wPlus;
    if (Math.abs(wPlus - wMinus) >= core.statistic) extreme++;
  }
  assert.equal(core.extremeCount, BigInt(extreme));
  assert.equal(core.totalReassignments, BigInt(total));
  assert.equal(core.pValue, extreme / total);
});
