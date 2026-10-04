import { test } from "node:test";
import assert from "node:assert/strict";
import { StateSequence, type Segment } from "../src/state-sequence.js";
import { TickInterpreter } from "./tick-interpreter.js";

test("样本保持至下一个样本（无 TTL）", () => {
  const seq = new StateSequence<string>();
  seq.insert({ t: 10, version: 0, value: "a" });
  seq.insert({ t: 25, version: 0, value: "b" });
  assert.deepEqual(seq.query(0, 40), [
    { start: 10, end: 25, value: "a" },
    { start: 25, end: 40, value: "b" },
  ]);
  assert.equal(seq.at(9), undefined);
  assert.equal(seq.at(10), "a");
  assert.equal(seq.at(24), "a");
  assert.equal(seq.at(25), "b");
});

test("TTL 到期产生空洞，空洞不被后续样本延长", () => {
  const seq = new StateSequence<string>();
  seq.insert({ t: 0, version: 0, value: "a", ttl: 5 });
  seq.insert({ t: 20, version: 0, value: "b" });
  // [0,5) 为 a，[5,20) 是空洞，[20,...) 为 b；空洞不会向前/向后填补
  assert.deepEqual(seq.query(0, 30), [
    { start: 0, end: 5, value: "a" },
    { start: 20, end: 30, value: "b" },
  ]);
  assert.equal(seq.at(4), "a");
  assert.equal(seq.at(5), undefined);
  assert.equal(seq.at(19), undefined);
  assert.equal(seq.at(20), "b");
});

test("TTL 与下一样本同时到达时不产生空洞", () => {
  const seq = new StateSequence<string>();
  seq.insert({ t: 0, version: 0, value: "a", ttl: 10 });
  seq.insert({ t: 10, version: 0, value: "b" });
  assert.deepEqual(seq.query(0, 15), [
    { start: 0, end: 10, value: "a" },
    { start: 10, end: 15, value: "b" },
  ]);
});

test("下一样本先于 TTL 到达时截断当前样本", () => {
  const seq = new StateSequence<string>();
  seq.insert({ t: 0, version: 0, value: "a", ttl: 100 });
  seq.insert({ t: 7, version: 0, value: "b" });
  assert.deepEqual(seq.query(0, 12), [
    { start: 0, end: 7, value: "a" },
    { start: 7, end: 12, value: "b" },
  ]);
});

test("同时间更正：版本高者生效，等于或更低被拒绝", () => {
  const seq = new StateSequence<string>();
  assert.equal(seq.insert({ t: 5, version: 1, value: "v1" }), true);
  assert.equal(seq.insert({ t: 5, version: 3, value: "v3" }), true);
  assert.equal(seq.insert({ t: 5, version: 2, value: "v2" }), false);
  assert.equal(seq.insert({ t: 5, version: 3, value: "v3-again" }), false);
  assert.equal(seq.at(5), "v3");
  assert.equal(seq.get(5)!.version, 3);
  assert.equal(seq.size, 1);
});

test("更正可改变 TTL 与值，并影响后续区间", () => {
  const seq = new StateSequence<string>();
  seq.insert({ t: 0, version: 0, value: "a", ttl: 3 });
  seq.insert({ t: 0, version: 1, value: "a2", ttl: 8 });
  assert.deepEqual(seq.query(0, 10), [{ start: 0, end: 8, value: "a2" }]);
});

test("删除样本后，前一样本按其 TTL 重新延展", () => {
  const seq = new StateSequence<string>();
  seq.insert({ t: 0, version: 0, value: "a" });
  seq.insert({ t: 10, version: 0, value: "b" });
  seq.insert({ t: 20, version: 0, value: "c" });
  assert.equal(seq.delete(10), true);
  assert.equal(seq.delete(10), false);
  assert.deepEqual(seq.query(0, 25), [
    { start: 0, end: 20, value: "a" },
    { start: 20, end: 25, value: "c" },
  ]);
});

test("删除后前一样本仍受自身 TTL 限制，空洞不被延长", () => {
  const seq = new StateSequence<string>();
  seq.insert({ t: 0, version: 0, value: "a", ttl: 6 });
  seq.insert({ t: 4, version: 0, value: "b" });
  seq.delete(4);
  // a 只持有到 t=6，之后是空洞而不是被延长
  assert.deepEqual(seq.query(0, 12), [{ start: 0, end: 6, value: "a" }]);
});

test("范围查询裁剪到 [start, end) 半开区间", () => {
  const seq = new StateSequence<string>();
  seq.insert({ t: 0, version: 0, value: "a" });
  seq.insert({ t: 10, version: 0, value: "b" });
  assert.deepEqual(seq.query(3, 10), [{ start: 3, end: 10, value: "a" }]);
  assert.deepEqual(seq.query(3, 15), [
    { start: 3, end: 10, value: "a" },
    { start: 10, end: 15, value: "b" },
  ]);
  assert.deepEqual(seq.query(10, 10), []);
  assert.deepEqual(seq.query(10, 5), []);
});

test("相邻同值段合并为最大等值段", () => {
  const seq = new StateSequence<number>();
  seq.insert({ t: 0, version: 0, value: 1 });
  seq.insert({ t: 5, version: 0, value: 1 });
  seq.insert({ t: 9, version: 0, value: 2 });
  seq.insert({ t: 12, version: 0, value: 1 });
  assert.deepEqual(seq.query(0, 20), [
    { start: 0, end: 9, value: 1 },
    { start: 9, end: 12, value: 2 },
    { start: 12, end: 20, value: 1 },
  ]);
});

test("空洞打断同值合并（空洞两侧不合并）", () => {
  const seq = new StateSequence<number>();
  seq.insert({ t: 0, version: 0, value: 1, ttl: 4 });
  seq.insert({ t: 8, version: 0, value: 1 });
  assert.deepEqual(seq.query(0, 12), [
    { start: 0, end: 4, value: 1 },
    { start: 8, end: 12, value: 1 },
  ]);
});

test("空序列与首样本之前的查询", () => {
  const seq = new StateSequence<string>();
  assert.deepEqual(seq.query(0, 100), []);
  seq.insert({ t: 50, version: 0, value: "x" });
  assert.deepEqual(seq.query(0, 60), [{ start: 50, end: 60, value: "x" }]);
});

test("自定义等值函数", () => {
  const seq = new StateSequence<number[]>((a, b) => a.length === b.length);
  seq.insert({ t: 0, version: 0, value: [1] });
  seq.insert({ t: 5, version: 0, value: [9] });
  assert.deepEqual(seq.query(0, 10), [{ start: 0, end: 10, value: [1] }]);
});

test("非法样本参数抛 TypeError", () => {
  const seq = new StateSequence<string>();
  assert.throws(() => seq.insert({ t: 1.5, version: 0, value: "x" }), TypeError);
  assert.throws(() => seq.insert({ t: 0, version: -1, value: "x" }), TypeError);
  assert.throws(() => seq.insert({ t: 0, version: 0, value: "x", ttl: 0 }), TypeError);
});

test("固定场景与逐 tick 解释器一致", () => {
  const seq = new StateSequence<string>();
  const ref = new TickInterpreter<string>();
  const ops = [
    { t: 3, version: 0, value: "a", ttl: 4 },
    { t: 10, version: 0, value: "b" },
    { t: 10, version: 2, value: "b2", ttl: 3 },
    { t: 10, version: 1, value: "rejected" },
    { t: 20, version: 0, value: "a" },
  ] as const;
  for (const op of ops) {
    assert.equal(seq.insert(op), ref.insert(op));
  }
  assert.equal(seq.delete(3), ref.delete(3));
  for (let start = 0; start < 30; start += 3) {
    for (let end = start; end <= 30; end += 3) {
      assert.deepEqual(seq.query(start, end), ref.interpret(start, end), `query(${start}, ${end})`);
    }
  }
});
