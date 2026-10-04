import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyCorrections,
  assignLayers,
  bruteForce,
  colorsNeeded,
  solve,
  validateItems,
  verifyCertificate,
} from "../src/index.js";
import type { Item } from "../src/index.js";

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

function randomItems(rand: () => number, n: number, maxTime: number, maxPrio: number): Item[] {
  const items: Item[] = [];
  for (let i = 0; i < n; i++) {
    const start = Math.floor(rand() * maxTime);
    const end = start + 1 + Math.floor(rand() * (maxTime - start));
    const priority = 1 + Math.floor(rand() * maxPrio);
    items.push({ id: i + 1, start, end, priority });
  }
  return items;
}

/** 扫描线求最大重叠深度（半开区间）。 */
function maxDepth(items: Item[]): number {
  const events: [number, number][] = [];
  for (const it of items) {
    events.push([it.start, 1], [it.end, -1]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0;
  let best = 0;
  for (const [, delta] of events) {
    cur += delta;
    best = Math.max(best, cur);
  }
  return best;
}

test("k=1 经典加权区间调度", () => {
  const items: Item[] = [
    { id: 1, start: 0, end: 6, priority: 5 },
    { id: 2, start: 1, end: 4, priority: 4 },
    { id: 3, start: 4, end: 6, priority: 4 },
    { id: 4, start: 6, end: 9, priority: 6 },
  ];
  const cert = solve(items, 1);
  assert.equal(cert.profit, 14); // 2+3+4
  assert.deepEqual(cert.selected, [2, 3, 4]);
  assert.equal(verifyCertificate(items, 1, cert), null);
});

test("半开区间：end == start 可同层相接", () => {
  const items: Item[] = [
    { id: 1, start: 0, end: 5, priority: 1 },
    { id: 2, start: 5, end: 10, priority: 1 },
  ];
  const cert = solve(items, 1);
  assert.deepEqual(cert.selected, [1, 2]);
  assert.deepEqual(cert.assignment, [
    { id: 1, layer: 0 },
    { id: 2, layer: 0 },
  ]);
});

test("k=2 允许两个重叠字幕各占一层", () => {
  const items: Item[] = [
    { id: 1, start: 0, end: 10, priority: 3 },
    { id: 2, start: 2, end: 8, priority: 2 },
    { id: 3, start: 3, end: 5, priority: 1 },
  ];
  const cert = solve(items, 2);
  assert.equal(cert.profit, 5); // 1+2，id=3 深度超限被舍弃
  assert.deepEqual(cert.selected, [1, 2]);
  const layers = cert.assignment.map((a) => a.layer).sort();
  assert.deepEqual(layers, [0, 1]);
  assert.equal(verifyCertificate(items, 2, cert), null);
});

test("并列 ID 序：收益相同优先包含较小 id", () => {
  const items: Item[] = [
    { id: 7, start: 0, end: 10, priority: 5 },
    { id: 3, start: 0, end: 10, priority: 5 },
  ];
  const cert = solve(items, 1);
  assert.deepEqual(cert.selected, [3]);
  assert.equal(cert.profit, 5);
});

test("并列 ID 序：跨位置比较（特征向量规则）", () => {
  // {1,9} 与 {2,3} 均可行且同收益，最小差异 id=1，含 1 者胜。
  const items: Item[] = [
    { id: 1, start: 0, end: 2, priority: 3 },
    { id: 9, start: 2, end: 4, priority: 3 },
    { id: 2, start: 0, end: 4, priority: 6 },
    { id: 3, start: 4, end: 6, priority: 0 },
  ];
  const cert = solve(items, 1);
  assert.deepEqual(cert.selected, [1, 3, 9]);
  assert.equal(cert.profit, 6);
});

test("证书校验：篡改同层重叠与收益被拒", () => {
  const items: Item[] = [
    { id: 1, start: 0, end: 10, priority: 3 },
    { id: 2, start: 2, end: 8, priority: 2 },
  ];
  const cert = solve(items, 2);
  assert.equal(verifyCertificate(items, 2, cert), null);

  const overlapped = {
    ...cert,
    assignment: [
      { id: 1, layer: 0 },
      { id: 2, layer: 0 },
    ],
  };
  assert.match(verifyCertificate(items, 2, overlapped)!, /重叠/);

  const badProfit = { ...cert, profit: cert.profit + 1 };
  assert.match(verifyCertificate(items, 2, badProfit)!, /收益/);

  const badLayer = { ...cert, assignment: [{ id: 1, layer: 2 }, { id: 2, layer: 0 }] };
  assert.match(verifyCertificate(items, 2, badLayer)!, /越界/);
});

test("更正时码后重算：修正 end 解除冲突，收益上升", () => {
  const items: Item[] = [
    { id: 1, start: 0, end: 10, priority: 8 },
    { id: 2, start: 9, end: 12, priority: 7 }, // 与 1 重叠，k=1 只能二选一
  ];
  const before = solve(items, 1);
  assert.deepEqual(before.selected, [1]);
  assert.equal(before.profit, 8);

  const correctedItems = applyCorrections(items, [{ id: 2, start: 10 }]);
  const after = solve(correctedItems, 1);
  assert.deepEqual(after.selected, [1, 2]);
  assert.equal(after.profit, 15);
  assert.equal(verifyCertificate(correctedItems, 1, after), null);
});

test("更正未知 id 与非法时码报错", () => {
  const items: Item[] = [{ id: 1, start: 0, end: 5, priority: 1 }];
  assert.throws(() => applyCorrections(items, [{ id: 99, start: 1 }]), /未知 id/);
  assert.throws(() => applyCorrections(items, [{ id: 1, end: 0 }]), /end > start/);
});

test("输入校验：超 20 项、区间非法、id 重复", () => {
  const ok: Item = { id: 1, start: 0, end: 1, priority: 1 };
  const tooMany = Array.from({ length: 21 }, (_, i) => ({ ...ok, id: i + 1 }));
  assert.throws(() => validateItems(tooMany), /超过上限 20/);
  assert.throws(() => validateItems([{ ...ok, end: 0 }]), /end > start/);
  assert.throws(() => validateItems([ok, { ...ok }]), /重复/);
});

test("着色数 == 最大重叠深度（区间图）", () => {
  const rand = mulberry32(20261005);
  for (let trial = 0; trial < 200; trial++) {
    const items = randomItems(rand, 1 + Math.floor(rand() * 12), 30, 9);
    const subset = items.filter(() => rand() < 0.6);
    assert.equal(colorsNeeded(subset), maxDepth(subset));
  }
});

test("小子集枚举核对：solve 与 bruteForce 一致", () => {
  for (const [seed, k] of [[1, 1], [2, 2], [3, 3], [4, 5]] as const) {
    const rand = mulberry32(seed);
    for (let trial = 0; trial < 60; trial++) {
      const n = 1 + Math.floor(rand() * 10);
      const items = randomItems(rand, n, 20, 9);
      const fast = solve(items, k);
      const slow = bruteForce(items, k);
      assert.equal(fast.profit, slow.profit, `seed=${seed} trial=${trial} profit`);
      assert.deepEqual(fast.selected, slow.selected, `seed=${seed} trial=${trial} selected`);
      assert.equal(verifyCertificate(items, k, fast), null);
      assert.ok(fast.assignment.every((a) => a.layer < k));
    }
  }
});

test("边界：空库与 k=0", () => {
  assert.deepEqual(solve([], 3).selected, []);
  const items: Item[] = [{ id: 1, start: 0, end: 1, priority: 5 }];
  const cert = solve(items, 0);
  assert.deepEqual(cert.selected, []);
  assert.equal(cert.profit, 0);
});

test("assignLayers 颜色数不超过 k 且同层不重叠", () => {
  const rand = mulberry32(777);
  for (let trial = 0; trial < 100; trial++) {
    const k = 1 + Math.floor(rand() * 4);
    const items = randomItems(rand, 1 + Math.floor(rand() * 10), 20, 9);
    const cert = solve(items, k);
    const chosen = items.filter((it) => cert.selected.includes(it.id));
    const layers = assignLayers(chosen);
    assert.ok(layers.every((a) => a.layer < k));
    assert.equal(verifyCertificate(items, k, cert), null);
  }
});
