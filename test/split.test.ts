import { test } from "node:test";
import assert from "node:assert/strict";
import { split, SplitError, type Recipient } from "../src/split.js";

const r = (
  id: string,
  num: number,
  den: number,
  min: number,
  max: number,
): Recipient => ({ id, weight: { num, den }, min, max });

test("等权三人分 100：最大余数，并列按 ID", () => {
  const out = split(100, [r("c", 1, 1, 0, 100), r("a", 1, 1, 0, 100), r("b", 1, 1, 0, 100)]);
  assert.deepEqual(out, new Map([["c", 33], ["a", 34], ["b", 33]]));
  assert.equal([...out.values()].reduce((s, v) => s + v, 0), 100);
});

test("权重 2:1 按比例取整", () => {
  const out = split(100, [r("a", 2, 1, 0, 100), r("b", 1, 1, 0, 100)]);
  assert.deepEqual([...out.values()], [67, 33]);
});

test("有理权重 1/3 : 1/6 等价 2:1", () => {
  const out = split(90, [r("a", 1, 3, 0, 90), r("b", 1, 6, 0, 90)]);
  assert.deepEqual([...out.values()], [60, 30]);
});

test("权重 0 且下限非零合法：恰好拿下限", () => {
  const out = split(10, [r("a", 0, 1, 3, 5), r("b", 1, 1, 0, 10)]);
  assert.deepEqual([...out.values()], [3, 7]);
});

test("上限饱和者退出，剩余继续按余数分配", () => {
  const out = split(100, [
    r("a", 1, 1, 0, 10),
    r("b", 1, 1, 0, 100),
    r("c", 1, 1, 0, 100),
  ]);
  assert.deepEqual([...out.values()], [10, 45, 45]);
});

test("下限先满足再按比例分剩余", () => {
  const out = split(20, [r("a", 1, 1, 5, 20), r("b", 1, 1, 0, 20)]);
  // 目标各 10；a 已有 5，补 5 后并列，余下 10 平分。
  assert.deepEqual([...out.values()], [10, 10]);
});

test("下限和超过总额：不可行报错", () => {
  assert.throws(
    () => split(5, [r("a", 1, 1, 3, 9), r("b", 1, 1, 3, 9)]),
    (err: unknown) => err instanceof SplitError && err.code === "INFEASIBLE",
  );
});

test("上限和小于总额：不可行报错", () => {
  assert.throws(
    () => split(10, [r("a", 1, 1, 0, 4), r("b", 1, 1, 0, 4)]),
    (err: unknown) => err instanceof SplitError && err.code === "INFEASIBLE",
  );
});

test("非法输入：重复 ID / min>max / 负权重 / 负总额", () => {
  assert.throws(() => split(1, [r("a", 1, 1, 0, 1), r("a", 1, 1, 0, 1)]), SplitError);
  assert.throws(() => split(1, [r("a", 1, 1, 2, 1)]), SplitError);
  assert.throws(() => split(1, [r("a", -1, 1, 0, 1)]), SplitError);
  assert.throws(() => split(-1, [r("a", 1, 1, 0, 1)]), SplitError);
  assert.throws(() => split(1, []), SplitError);
});

test("全部权重为 0：退化为尽量均分（最小化平方和）", () => {
  const out = split(7, [r("a", 0, 1, 0, 10), r("b", 0, 1, 0, 10)]);
  assert.deepEqual([...out.values()], [4, 3]);
});

test("总额为 0：全部取下限（下限和必须为 0）", () => {
  const out = split(0, [r("a", 1, 1, 0, 5), r("b", 2, 1, 0, 5)]);
  assert.deepEqual([...out.values()], [0, 0]);
});

test("并列最优按 ID 升序字典序最大", () => {
  // 目标各 0.5，只能一人得 1 分：ID 小者优先。
  const out = split(1, [r("b", 1, 1, 0, 1), r("a", 1, 1, 0, 1)]);
  assert.deepEqual([...out.values()], [0, 1]);
});
