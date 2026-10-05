import assert from "node:assert/strict";
import test from "node:test";
import { bruteForce } from "../src/brute";
import { SubtitleItem, verifyCertificate } from "../src/model";
import { solve } from "../src/solve";

function item(id: string, start: number, end: number, priority: number): SubtitleItem {
  return { id, start, end, priority };
}

test("半开区间：端点相接可同层", () => {
  const items = [item("b", 2, 4, 1), item("a", 0, 2, 1)];
  const cert = solve(items, 1);
  assert.equal(cert.profit, 2);
  assert.deepEqual(cert.selected, ["a", "b"]);
  assert.deepEqual(cert.layers, [["a", "b"]]);
});

test("k=1 退化为加权区间调度", () => {
  const items = [
    item("s1", 0, 3, 5),
    item("s2", 1, 4, 6),
    item("s3", 3, 6, 5),
    item("s4", 6, 8, 4),
  ];
  const cert = solve(items, 1);
  // 最优：s1(5) + s3(5) + s4(4) = 14
  assert.equal(cert.profit, 14);
  assert.deepEqual(cert.selected, ["s1", "s3", "s4"]);
  verifyCertificate(items, 1, cert);
});

test("k=2 利用第二层提升收益", () => {
  const items = [
    item("a", 0, 10, 5),
    item("b", 1, 2, 4),
    item("c", 2, 3, 4),
    item("d", 3, 4, 4),
  ];
  const cert1 = solve(items, 1);
  assert.equal(cert1.profit, 12); // b+c+d
  const cert2 = solve(items, 2);
  assert.equal(cert2.profit, 17); // a + b + c + d
  verifyCertificate(items, 2, cert2);
});

test("并列时按 ID 序选字典序最小集合", () => {
  // x 与 y 互斥且收益相同，应选 ID 较小的 a 开头者。
  const items = [item("y", 0, 5, 7), item("a", 0, 5, 7)];
  const cert = solve(items, 1);
  assert.deepEqual(cert.selected, ["a"]);
});

test("零收益条目不进入最优集合（并列取条目数最少）", () => {
  const items = [item("z", 0, 1, 0), item("a", 0, 1, 5)];
  const cert = solve(items, 2);
  assert.deepEqual(cert.selected, ["a"]);
  assert.equal(cert.profit, 5);
});

test("更正时码后重算结果随之更新", () => {
  const items = [
    item("s1", 0, 4, 10),
    item("s2", 2, 6, 9),
    item("s3", 4, 8, 9),
  ];
  const before = solve(items, 1);
  assert.deepEqual(before.selected, ["s1", "s3"]);
  // 更正 s2 时码使其与 s1、s3 均不冲突
  const fixed = items.map((it) =>
    it.id === "s2" ? { ...it, start: 8, end: 9 } : it,
  );
  const after = solve(fixed, 1);
  assert.deepEqual(after.selected, ["s1", "s2", "s3"]);
  assert.equal(after.profit, 28);
});

test("输入校验：超 20 项 / 非法时码 / 重复 ID / 非法 k", () => {
  const many = Array.from({ length: 21 }, (_, i) => item(`id${i}`, i, i + 1, 1));
  assert.throws(() => solve(many, 1), /至多为 20/);
  assert.throws(() => solve([item("a", 3, 3, 1)], 1), /start < end/);
  assert.throws(() => solve([item("a", 0, 1, 1), item("a", 1, 2, 1)], 1), /重复/);
  assert.throws(() => solve([item("a", 0, 1, 1)], 0), /k 必须/);
});

test("证书校验能发现篡改", () => {
  const items = [item("a", 0, 2, 3), item("b", 1, 3, 4)];
  const cert = solve(items, 1);
  verifyCertificate(items, 1, cert);
  // 伪造同层重叠分配
  assert.throws(
    () =>
      verifyCertificate(items, 2, {
        k: 2,
        profit: 7,
        selected: ["a", "b"],
        layers: [["a", "b"]],
      }),
    /同层重叠/,
  );
  // 伪造收益
  assert.throws(
    () =>
      verifyCertificate(items, 1, { k: 1, profit: 99, selected: ["b"], layers: [["b"]] }),
    /收益不符/,
  );
});

// 可复现的伪随机生成器（mulberry32）
function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("小子集核对：随机用例下 DP 与着色枚举暴力一致", () => {
  const TRIALS = 300;
  for (let t = 0; t < TRIALS; t++) {
    const rand = rng(t * 7919 + 13);
    const n = 1 + Math.floor(rand() * 8); // 1..8 条
    const k = 1 + Math.floor(rand() * 3); // 1..3 层
    const items: SubtitleItem[] = [];
    for (let i = 0; i < n; i++) {
      const start = Math.floor(rand() * 10);
      const end = start + 1 + Math.floor(rand() * 5);
      const priority = Math.floor(rand() * 10); // 含 0 收益
      items.push(item(`s${i}`, start, end, priority));
    }
    const cert = solve(items, k);
    const brute = bruteForce(items, k);
    assert.equal(cert.profit, brute.profit, `trial ${t} 收益不一致`);
    assert.deepEqual(cert.selected, brute.ids, `trial ${t} 选中集合不一致`);
    verifyCertificate(items, k, cert);
  }
});

test("规模上限：20 项可解且与暴力一致", () => {
  const rand = rng(20261005);
  const items: SubtitleItem[] = [];
  for (let i = 0; i < 20; i++) {
    const start = Math.floor(rand() * 30);
    items.push(item(`t${String(i).padStart(2, "0")}`, start, start + 1 + Math.floor(rand() * 6), Math.floor(rand() * 20)));
  }
  const cert = solve(items, 3);
  const brute = bruteForce(items, 3);
  assert.equal(cert.profit, brute.profit);
  assert.deepEqual(cert.selected, brute.ids);
  verifyCertificate(items, 3, cert);
});
