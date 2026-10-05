import test from "node:test";
import assert from "node:assert/strict";
import { rational, quantileRank } from "../src/rational.js";
import {
  WindowState,
  createWindow,
  addEvent,
  correctEvent,
  quantile,
  rankOf,
  toSortedArray,
} from "../src/window.js";
import { kth, size as treeSize, toSortedArray as treeSorted } from "../src/order-stats-tree.js";

test("persistent index: every historical snapshot stays fully readable", () => {
  const capacity = 5;
  let w: WindowState = createWindow(capacity);
  const snapshots: { state: WindowState; sorted: number[] }[] = [];
  const model: { id: number; value: number }[] = [];

  const record = () => {
    snapshots.push({
      state: w,
      sorted: model.map((e) => e.value).sort((a, b) => a - b),
    });
  };
  record();

  for (let i = 1; i <= 8; i++) {
    w = addEvent(w, i, (i * 7) % 9); // 7,5,3,1,8 then evictions
    model.push({ id: i, value: (i * 7) % 9 });
    if (model.length > capacity) model.shift();
    record();
  }
  w = correctEvent(w, 6, -4);
  (model.find((e) => e.id === 6) as { value: number }).value = -4;
  record();
  w = correctEvent(w, 8, 100);
  (model.find((e) => e.id === 8) as { value: number }).value = 100;
  record();

  // Re-verify every snapshot long after it was superseded.
  for (const [i, snap] of snapshots.entries()) {
    assert.deepEqual(toSortedArray(snap.state), snap.sorted, `snapshot ${i} contents`);
    const n = snap.sorted.length;
    if (n === 0) {
      assert.equal(quantile(snap.state, rational(1, 2)), null);
      continue;
    }
    for (const p of [rational(0, 1), rational(1, 4), rational(1, 2), rational(3, 4), rational(1, 1)]) {
      assert.equal(
        quantile(snap.state, p),
        snap.sorted[quantileRank(p, n) - 1],
        `snapshot ${i} quantile ${p.num}/${p.den}`,
      );
    }
    for (const v of [-5, 0, 4, 7, 50]) {
      assert.equal(rankOf(snap.state, v), snap.sorted.filter((x) => x < v).length);
    }
  }
});

test("persistent tree roots are never mutated by later updates", () => {
  let w = createWindow(10);
  w = addEvent(w, 1, 3);
  const rootAfterOne = w.root;
  w = addEvent(w, 2, 1);
  const rootAfterTwo = w.root;
  w = addEvent(w, 3, 2);
  w = correctEvent(w, 1, 30);

  assert.deepEqual(treeSorted(rootAfterOne), [3]);
  assert.equal(treeSize(rootAfterOne), 1);
  assert.deepEqual(treeSorted(rootAfterTwo), [1, 3]);
  assert.equal(kth(rootAfterTwo, 1), 1);
  assert.equal(kth(rootAfterTwo, 2), 3);
  assert.deepEqual(toSortedArray(w), [1, 2, 30]);
});
