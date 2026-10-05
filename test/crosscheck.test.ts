import test from "node:test";
import assert from "node:assert/strict";
import { enumerateBest } from "../src/enumerate.js";
import { sameSeq, solve } from "../src/solver.js";
import { DeltaPackage, Problem } from "../src/types.js";

/** mulberry32 确定性伪随机数。 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomProblem(rand: () => number, index: number): Problem {
  const nodeCount = 2 + Math.floor(rand() * 7); // 2..8 个版本节点
  const nodes = Array.from({ length: nodeCount }, (_, i) => `v${i}`);
  const edgeCount = 1 + Math.floor(rand() * 14); // 1..14 条边
  const packages: DeltaPackage[] = [];
  for (let i = 0; i < edgeCount; i++) {
    const from = nodes[Math.floor(rand() * nodeCount)] as string;
    const to = nodes[Math.floor(rand() * nodeCount)] as string;
    if (from === to) continue;
    packages.push({
      id: `e${index}_${i}`,
      from,
      to,
      bytes: 1 + Math.floor(rand() * 50),
      peak: Math.floor(rand() * 40),
    });
  }
  return {
    start: "v0",
    target: nodes[nodeCount - 1] as string,
    spaceLimit: 30 + Math.floor(rand() * 120),
    packages,
  };
}

test("随机小图: 求解器与枚举对照一致 (300 例)", () => {
  const rand = rng(20261005);
  let feasible = 0;
  for (let i = 0; i < 300; i++) {
    const p = randomProblem(rand, i);
    const res = solve(p);
    const enumRes = enumerateBest(p);
    assert.ok(!enumRes.truncated, `用例 ${i} 枚举不应截断`);
    if (enumRes.best === null) {
      assert.ok(!res.ok, `用例 ${i}: 枚举无可行路径但求解器给出方案`);
    } else {
      assert.ok(res.ok, `用例 ${i}: 枚举有解但求解器无解`);
      assert.equal(res.totalBytes, enumRes.best.cost, `用例 ${i} 总下载量不一致`);
      assert.ok(sameSeq(res.sequence, enumRes.best.seq), `用例 ${i} 选包序列不一致`);
      feasible += 1;
    }
  }
  assert.ok(feasible > 50, `可行用例过少 (${feasible})，随机图生成可能有问题`);
});

test("枚举: 手工小图逐一对照", () => {
  const p: Problem = {
    start: "A",
    target: "D",
    spaceLimit: 500,
    packages: [
      { id: "ab", from: "A", to: "B", bytes: 60, peak: 10 },
      { id: "bd", from: "B", to: "D", bytes: 40, peak: 10 },
      { id: "ac", from: "A", to: "C", bytes: 60, peak: 10 },
      { id: "cd", from: "C", to: "D", bytes: 40, peak: 10 },
      { id: "ad", from: "A", to: "D", bytes: 150, peak: 10 },
    ],
  };
  const enumRes = enumerateBest(p);
  assert.equal(enumRes.pathsExamined, 3);
  assert.deepEqual(enumRes.best, { cost: 100, seq: ["ab", "bd"] });
  const res = solve(p);
  assert.ok(res.ok);
  assert.deepEqual(res.sequence, ["ab", "bd"]);
});
