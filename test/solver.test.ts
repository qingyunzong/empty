import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { solve, type SolveStats } from '../src/solver.js';
import { exhaustiveOptimum } from '../src/exhaustive.js';
import { verifyCertificate } from '../src/certificate.js';
import { parseInstance } from '../src/parse.js';
import type { Instance, RectSpec } from '../src/types.js';

function R(id: string, w: number, h: number, profit: number, rotate = false): RectSpec {
  return { id, w, h, profit, rotate };
}

function inst(
  width: number,
  height: number,
  rectangles: RectSpec[],
  forbidden: Array<[number, number]> = [],
): Instance {
  return { grid: { width, height, forbidden }, rectangles };
}

test('单矩形恰好铺满网格', () => {
  const i = inst(2, 2, [R('a', 2, 2, 5)]);
  const sol = solve(i);
  assert.equal(sol.profit, 5);
  assert.equal(sol.area, 4);
  assert.equal(sol.placements.length, 1);
  assert.deepEqual(verifyCertificate(i, sol), []);
});

test('允许旋转时旋转后放入', () => {
  const i = inst(2, 3, [R('a', 3, 1, 7, true)]);
  const sol = solve(i);
  assert.equal(sol.profit, 7);
  const p = sol.placements[0]!;
  assert.deepEqual([p.w, p.h], [1, 3]);
  assert.deepEqual(verifyCertificate(i, sol), []);
});

test('禁止旋转时放不进则放弃', () => {
  const sol = solve(inst(2, 3, [R('a', 3, 1, 7, false)]));
  assert.equal(sol.profit, 0);
  assert.equal(sol.placements.length, 0);
});

test('禁区阻挡大矩形但不挡小矩形', () => {
  const forbidden: Array<[number, number]> = [
    [0, 0],
    [1, 1],
  ];
  const i = inst(2, 2, [R('big', 2, 2, 100), R('dot', 1, 1, 7)], forbidden);
  const sol = solve(i);
  assert.equal(sol.profit, 7);
  assert.equal(sol.placements.length, 1);
  assert.equal(sol.placements[0]!.id, 'dot');
  assert.deepEqual(verifyCertificate(i, sol), []);
});

test('子集选择：装不下的低收益矩形被舍弃', () => {
  // 4x4: A(2x2,p10) B(2x2,p10) D(1x1,p1) 可共存；C(3x3,p9) 与 A+B 冲突
  const i = inst(4, 4, [R('A', 2, 2, 10), R('B', 2, 2, 10), R('C', 3, 3, 9), R('D', 1, 1, 1)]);
  const sol = solve(i);
  assert.equal(sol.profit, 21);
  assert.equal(sol.area, 9);
  assert.deepEqual(
    sol.placements.map((p) => p.id).sort(),
    ['A', 'B', 'D'],
  );
  assert.deepEqual(verifyCertificate(i, sol), []);
});

test('同收益取总面积更小者', () => {
  // 3x3: A(2x2,p10) 与 B(3x3,p10) 互斥, 收益相同应选面积小的 A
  const i = inst(3, 3, [R('A', 2, 2, 10), R('B', 3, 3, 10)]);
  const sol = solve(i);
  assert.equal(sol.profit, 10);
  assert.equal(sol.area, 4);
  assert.equal(sol.placements[0]!.id, 'A');
});

test('零收益矩形不进入最优子集', () => {
  const sol = solve(inst(3, 3, [R('z', 1, 1, 0)]));
  assert.equal(sol.profit, 0);
  assert.equal(sol.area, 0);
  assert.equal(sol.placements.length, 0);
});

test('证书校验能发现篡改', () => {
  const i = inst(3, 3, [R('a', 2, 2, 5), R('b', 1, 1, 1)], [[2, 2]]);
  assert.ok(
    verifyCertificate(i, {
      profit: 6,
      area: 5,
      placements: [
        { id: 'a', x: 0, y: 0, w: 2, h: 2 },
        { id: 'b', x: 0, y: 0, w: 1, h: 1 },
      ],
    }).some((m) => m.includes('重叠')),
  );
  assert.ok(
    verifyCertificate(i, { profit: 1, area: 1, placements: [{ id: 'b', x: 2, y: 2, w: 1, h: 1 }] }).some((m) =>
      m.includes('禁区'),
    ),
  );
  assert.ok(
    verifyCertificate(i, { profit: 5, area: 4, placements: [{ id: 'a', x: 0, y: 0, w: 1, h: 4 }] }).some((m) =>
      m.includes('不符'),
    ),
  );
  assert.ok(
    verifyCertificate(i, { profit: 5, area: 4, placements: [{ id: 'a', x: 2, y: 0, w: 2, h: 2 }] }).some((m) =>
      m.includes('越界'),
    ),
  );
});

test('10 个相同 1x1 矩形不引发组合爆炸', () => {
  const rects = Array.from({ length: 10 }, (_, k) => R(`u${k}`, 1, 1, 1));
  const i = inst(8, 8, rects);
  const stats: SolveStats = { nodes: 0, subsetsTried: 0 };
  const t0 = performance.now();
  const sol = solve(i, { stats });
  const ms = performance.now() - t0;
  assert.equal(sol.profit, 10);
  assert.equal(sol.area, 10);
  assert.ok(ms < 2000, `耗时 ${ms}ms 过长`);
  assert.deepEqual(verifyCertificate(i, sol), []);
});

test('demo 实例（8x8, 10 矩形, 中央禁区）可解且证书合法', () => {
  const i = parseInstance(JSON.parse(readFileSync('examples/demo.json', 'utf8')));
  const stats: SolveStats = { nodes: 0, subsetsTried: 0 };
  const t0 = performance.now();
  const sol = solve(i, { stats });
  const ms = performance.now() - t0;
  assert.ok(ms < 10_000, `耗时 ${ms}ms 过长`);
  assert.deepEqual(verifyCertificate(i, sol), []);
  console.log(
    `    demo: 收益 ${sol.profit}, 面积 ${sol.area}, 放置 ${sol.placements.length}/10, ${ms.toFixed(1)} ms, 节点 ${stats.nodes}`,
  );
});

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

test('随机极小实例：主求解器与全枚举核对一致', () => {
  const rand = mulberry32(20261005);
  for (let iter = 0; iter < 40; iter++) {
    const width = 2 + Math.floor(rand() * 3);
    const height = 2 + Math.floor(rand() * 3);
    const forbidden: Array<[number, number]> = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (rand() < 0.15) forbidden.push([x, y]);
      }
    }
    const n = 1 + Math.floor(rand() * 5);
    const rects = Array.from({ length: n }, (_, k) =>
      R(`r${k}`, 1 + Math.floor(rand() * 3), 1 + Math.floor(rand() * 3), Math.floor(rand() * 13), rand() < 0.5),
    );
    const i = inst(width, height, rects, forbidden);
    const sol = solve(i);
    const ex = exhaustiveOptimum(i);
    assert.ok(ex.complete);
    assert.equal(sol.profit, ex.profit, `iter ${iter} 收益不一致`);
    assert.equal(sol.area, ex.area, `iter ${iter} 面积不一致`);
    assert.deepEqual(verifyCertificate(i, sol), [], `iter ${iter} 证书非法`);
  }
});
