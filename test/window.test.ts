import test from "node:test";
import assert from "node:assert/strict";
import { SignalSeries, directWindowAverage } from "../src/signal.js";
import type { Cell } from "../src/types.js";

// 手工核算的序列：
//   t0:{10,1} t1:null t2:{20,2} t3:{30,0} t4:{40,1}
// 有效权重：t0=1*1*(4*2)=8, t2=2*3*(2*4)=48, t3=0*4*(3*4)=0, t4=1*1*(4*4)=16
const cells: Cell[] = [
  { value: 10, weight: 1 },
  null,
  { value: 20, weight: 2 },
  { value: 30, weight: 0 },
  { value: 40, weight: 1 },
];

test("最近 k 个有效样本的加权平均（手工核算）", () => {
  const s = new SignalSeries(3, cells);
  const r = s.windowAverage(4, 3)!;
  assert.equal(r.totalWeight, 64); // 16 + 0 + 48
  assert.equal(r.average, 1600 / 64); // (16*40 + 0*30 + 48*20) / 64 = 25
  assert.equal(r.average, 25);
  assert.equal(r.count, 3);
  assert.equal(r.from, 2);
  assert.equal(r.to, 4);
});

test("缺失样本占时间位置但不计权重、不计入 k", () => {
  const s = new SignalSeries(4, cells);
  const r = s.windowAverage(4, 4)!;
  // k=4 越过 t1 的缺测位置，取到 t0
  assert.equal(r.count, 4);
  assert.equal(r.from, 0);
  assert.equal(r.totalWeight, 72); // 8 + 48 + 0 + 16
  assert.equal(r.average, 1680 / 72);
});

test("全零权重返回空", () => {
  const s = new SignalSeries(2, [
    { value: 5, weight: 0 },
    null,
    { value: 7, weight: 0 },
  ]);
  assert.equal(s.windowAverage(2, 2), null);
  assert.equal(directWindowAverage(s.snapshot(), 2, 2), null);
});

test("输入权重必须是非负整数", () => {
  assert.throws(() => new SignalSeries(2, [{ value: 1, weight: -1 }]), TypeError);
  assert.throws(() => new SignalSeries(2, [{ value: 1, weight: 0.5 }]), TypeError);
  assert.throws(
    () => new SignalSeries(2, [{ value: Number.NaN, weight: 1 }]),
    TypeError,
  );
});

test("窗口参数校验", () => {
  const s = new SignalSeries(2, cells);
  assert.throws(() => s.windowAverage(4, 0), RangeError);
  assert.throws(() => s.windowAverage(5, 2), RangeError);
  assert.throws(() => s.windowAverage(-1, 2), RangeError);
});

test("增量路径与直接分数计算一致", () => {
  const s = new SignalSeries(3, cells);
  const snap = s.snapshot();
  for (let end = 0; end < cells.length; end++) {
    for (let k = 1; k <= 5; k++) {
      assert.deepEqual(s.windowAverage(end, k), directWindowAverage(snap, end, k));
    }
  }
});
