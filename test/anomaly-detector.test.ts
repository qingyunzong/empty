import { test } from "node:test";
import assert from "node:assert/strict";
import { AnomalyDetector, type Segment } from "../src/anomaly-detector.ts";

function memberIdsOf(segs: Segment[]): number[][] {
  return segs.map((s) => s.memberIds);
}

test("空检测器与单点都没有异常段", () => {
  const d = new AnomalyDetector(10);
  assert.deepEqual(d.segments(), []);
  d.insert(1, 5);
  assert.deepEqual(d.segments(), []);
  assert.equal(d.size, 1);
});

test("阈值边界：差值必须严格大于阈值", () => {
  const d = new AnomalyDetector(10);
  d.insert(1, 0);
  d.insert(2, 10); // 差值 == 阈值，不构成异常边
  assert.deepEqual(d.segments(), []);
  d.insert(3, 20.5); // 差值 10.5 > 10，构成异常边
  const segs = d.segments();
  assert.equal(segs.length, 1);
  assert.deepEqual(segs[0].memberIds, [2, 3]);
  assert.equal(segs[0].edgeCount, 1);
  assert.equal(segs[0].startValue, 10);
  assert.equal(segs[0].endValue, 20.5);
});

test("段 ID 取成员中的最小 id，与插入顺序无关", () => {
  const d = new AnomalyDetector(10);
  d.insert(99, 0);
  d.insert(7, 50);
  d.insert(42, 100);
  const segs = d.segments();
  assert.equal(segs.length, 1);
  assert.equal(segs[0].id, 7);
  assert.deepEqual(segs[0].memberIds, [99, 7, 42]);
  assert.equal(segs[0].edgeCount, 2);
});

test("插入点拆分旧边：两条新边都不异常时段消失", () => {
  const d = new AnomalyDetector(10);
  d.insert(1, 0);
  d.insert(2, 20);
  assert.equal(d.segments().length, 1);
  d.insert(3, 10); // 旧边 20 被拆成 10、10，均不超过阈值
  assert.deepEqual(d.segments(), []);
});

test("插入点拆分旧边：一个段被切成两个段", () => {
  const d = new AnomalyDetector(10);
  d.insert(1, 0);
  d.insert(2, 40);
  d.insert(3, 60);
  d.insert(4, 100);
  assert.deepEqual(memberIdsOf(d.segments()), [[1, 2, 3, 4]]);
  d.insert(5, 50); // 旧边 (40,60) 拆成 10、10，段被切成 {0,40} 与 {60,100}
  assert.deepEqual(memberIdsOf(d.segments()), [
    [1, 2],
    [3, 4],
  ]);
});

test("插入点拆分旧边：新点并入剩余段", () => {
  const d = new AnomalyDetector(10);
  d.insert(1, 0);
  d.insert(2, 40);
  d.insert(3, 60);
  d.insert(4, 100);
  d.insert(5, 45); // 旧边 (40,60) 拆成 5、15：左半脱离，右半带上新点
  assert.deepEqual(memberIdsOf(d.segments()), [
    [1, 2],
    [5, 3, 4],
  ]);
});

test("删除点合并新边：产生新的异常段", () => {
  const d = new AnomalyDetector(60);
  d.insert(1, 0);
  d.insert(2, 50);
  d.insert(3, 100);
  assert.deepEqual(d.segments(), []); // 边 50、50 均不异常
  d.delete(2); // 合并为边 100 > 60
  assert.deepEqual(memberIdsOf(d.segments()), [[1, 3]]);
});

test("删除点合并新边：两个段连成一段", () => {
  const d = new AnomalyDetector(15);
  d.insert(1, 0);
  d.insert(2, 20);
  d.insert(3, 25);
  d.insert(4, 45);
  // 边 20、5、20 → 段 {0,20} 与 {25,45}
  assert.deepEqual(memberIdsOf(d.segments()), [
    [1, 2],
    [3, 4],
  ]);
  d.delete(3); // 边 (20,25)、(25,45) 合并为 (20,45)=25，异常 → 连成一段
  assert.deepEqual(memberIdsOf(d.segments()), [[1, 2, 4]]);
});

test("删除点使段收缩直至消失", () => {
  const d = new AnomalyDetector(10);
  d.insert(1, 0);
  d.insert(2, 30);
  d.insert(3, 60);
  assert.deepEqual(memberIdsOf(d.segments()), [[1, 2, 3]]);
  d.delete(2); // 合并边 60 仍异常 → 段 {0,60}
  assert.deepEqual(memberIdsOf(d.segments()), [[1, 3]]);
  d.delete(3);
  assert.deepEqual(d.segments(), []);
});

test("相同值按 id 排序，差值为 0 不构成异常边", () => {
  const d = new AnomalyDetector(0);
  d.insert(2, 5);
  d.insert(1, 5);
  assert.deepEqual(
    d.snapshot().map((p) => p.id),
    [1, 2],
  );
  assert.deepEqual(d.segments(), []);
  d.insert(3, 6); // 差值 1 > 0
  assert.deepEqual(memberIdsOf(d.segments()), [[2, 3]]);
});

test("非法输入：重复 id、非法阈值、删除不存在的 id", () => {
  assert.throws(() => new AnomalyDetector(-1), RangeError);
  assert.throws(() => new AnomalyDetector(NaN), RangeError);
  const d = new AnomalyDetector(10);
  d.insert(1, 0);
  assert.throws(() => d.insert(1, 100), /duplicate id/);
  assert.throws(() => d.insert(2, Infinity), RangeError);
  assert.equal(d.delete(999), false);
  assert.equal(d.delete(1), true);
  assert.equal(d.has(1), false);
});

/** mulberry32：确定性伪随机数生成器，保证测试可复现。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("随机插入/删除与完整边扫描逐步对照", () => {
  const cases: Array<[seed: number, ops: number, threshold: number]> = [
    [1, 2000, 10],
    [2, 2000, 3],
    [3, 1000, 0],
    [4, 1000, 50],
  ];
  for (const [seed, ops, threshold] of cases) {
    const rand = mulberry32(seed);
    const d = new AnomalyDetector(threshold);
    const live: number[] = [];
    let nextId = 1;
    for (let step = 0; step < ops; step += 1) {
      if (live.length === 0 || rand() < 0.55) {
        const id = nextId;
        nextId += 1;
        d.insert(id, Math.floor(rand() * 100));
        live.push(id);
      } else {
        const idx = Math.floor(rand() * live.length);
        const id = live[idx];
        live.splice(idx, 1);
        assert.equal(d.delete(id), true);
      }
      assert.deepEqual(
        d.segments(),
        d.fullScan(),
        `seed=${seed} threshold=${threshold} step=${step}`,
      );
    }
  }
});

test("段的不变量：极大、有序、段 ID 为最小成员 id", () => {
  const rand = mulberry32(42);
  const d = new AnomalyDetector(8);
  for (let i = 1; i <= 300; i += 1) {
    d.insert(i, Math.floor(rand() * 60));
  }
  const segs = d.segments();
  const points = d.snapshot();
  const valueOf = new Map(points.map((p) => [p.id, p.value]));
  let prevEnd = -Infinity;
  for (const seg of segs) {
    assert.ok(seg.memberIds.length >= 2, "段至少包含两个成员");
    assert.equal(seg.id, Math.min(...seg.memberIds), "段 ID 为最小成员 id");
    assert.equal(seg.edgeCount, seg.memberIds.length - 1);
    const values = seg.memberIds.map((id) => valueOf.get(id)!);
    for (let i = 1; i < values.length; i += 1) {
      assert.ok(values[i] - values[i - 1] > 8, "段内每条边都异常");
    }
    assert.ok(seg.startValue > prevEnd, "段按值有序且不重叠");
    prevEnd = seg.endValue;
  }
});
