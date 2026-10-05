import test from "node:test";
import assert from "node:assert/strict";
import { SignalSeries } from "../src/signal.js";
import { exactWindowAverage, rationalToNumber } from "../src/reference.js";
import type { Cell } from "../src/types.js";

const original: Cell[] = [
  { value: 4, weight: 1 },
  { value: 6, weight: 2 },
  null,
  { value: 8, weight: 1 },
  { value: 10, weight: 3 },
  { value: 12, weight: 1 },
  { value: 14, weight: 0 },
];

function assertMatchesExact(s: SignalSeries, cells: readonly Cell[]): void {
  for (let end = 0; end < cells.length; end++) {
    for (let k = 1; k <= 4; k++) {
      const exact = exactWindowAverage(cells, end, k);
      const actual = s.windowAverage(end, k);
      if (exact === null) {
        assert.equal(actual, null, `end=${end} k=${k}`);
      } else {
        assert.ok(actual !== null, `end=${end} k=${k}`);
        assert.equal(actual.average, rationalToNumber(exact), `end=${end} k=${k}`);
      }
    }
  }
}

test("分支更正后旧视图保留并与精确模型一致", () => {
  const oldView = new SignalSeries(3, original);
  const before = oldView.snapshot();

  const branch = oldView.branch();
  branch.correct(1, { value: 60, weight: 5 });
  branch.correct(6, { value: 14, weight: 2 });

  // 旧视图不受分支更正影响
  assert.deepEqual(oldView.snapshot(), before);
  assertMatchesExact(oldView, original);

  // 分支与完整精确重采样再加权模型核对一致
  assertMatchesExact(branch, branch.snapshot());
});

test("分支删除样本后与精确重采样模型核对一致", () => {
  const oldView = new SignalSeries(3, original);
  const branch = oldView.branch();
  branch.delete(4); // 改变后续窗口与相邻权重
  branch.delete(0);

  assert.notDeepEqual(branch.snapshot(), oldView.snapshot());
  assertMatchesExact(oldView, original); // 旧视图保持
  assertMatchesExact(branch, branch.snapshot()); // 分支与精确模型一致
});

test("旧视图与分支的全零权重行为一致（均返回空）", () => {
  const s = new SignalSeries(2, [
    { value: 1, weight: 0 },
    { value: 2, weight: 0 },
  ]);
  const b = s.branch();
  b.correct(1, { value: 2, weight: 1 });
  assert.equal(s.windowAverage(1, 2), null); // 旧视图仍全零
  assert.ok(b.windowAverage(1, 2) !== null); // 分支已有非零权重
});
