import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DagScheduler,
  EXIT,
  type ComputeOk,
  type CriticalEdge,
} from "../src/critical-path.js";

function criticalKeys(edges: CriticalEdge[]): string[] {
  return edges.map((e) => `${e.from}->${e.to}`).sort();
}

/** 构造经典 CPM 示例图：
 *  A(源) -5-> C, B(源) -3-> C, A -2-> D(汇)
 *  工期 5，唯一关键边 A->C 与虚拟边 C->EXIT。
 */
function buildClassic(): DagScheduler {
  const g = new DagScheduler();
  g.addEdge("A", "C", 5);
  g.addEdge("B", "C", 3);
  g.addEdge("A", "D", 2);
  return g;
}

test("经典图：最早/最晚开始与关键边", () => {
  const g = buildClassic();
  const r = g.compute();
  assert.ok(r.ok);
  assert.equal(r.duration, 5);
  assert.equal(r.earliestStart.get("A"), 0);
  assert.equal(r.earliestStart.get("B"), 0);
  assert.equal(r.earliestStart.get("C"), 5);
  assert.equal(r.earliestStart.get("D"), 2);
  // 多终点共用零耗时出口：汇点 C、D 的 LS 都等于总工期
  assert.equal(r.latestStart.get("C"), 5);
  assert.equal(r.latestStart.get("D"), 5);
  assert.equal(r.latestStart.get("A"), 0); // min(5-5, 5-2)
  assert.equal(r.latestStart.get("B"), 2); // 5-3，有 2 天浮动
  assert.deepEqual(criticalKeys(r.criticalEdges), ["A->C", `C->${EXIT}`]);
  const exitEdge = r.criticalEdges.find((e) => e.to === EXIT)!;
  assert.equal(exitEdge.weight, 0);
  assert.equal(exitEdge.virtual, true);
});

test("零时长边合法且可成为关键边", () => {
  const g = new DagScheduler();
  g.addEdge("A", "B", 0);
  g.addEdge("B", "C", 4);
  g.addEdge("A", "D", 4);
  g.addEdge("D", "C", 0);
  const r = g.compute();
  assert.ok(r.ok);
  assert.equal(r.duration, 4);
  // 两条路径等长，所有边（含零时长边）都是关键边
  assert.deepEqual(criticalKeys(r.criticalEdges), [
    "A->B",
    "A->D",
    "B->C",
    `C->${EXIT}`,
    "D->C",
  ]);
});

test("多个源点与多个汇点共用虚拟出口", () => {
  const g = new DagScheduler();
  g.addEdge("S1", "M", 2);
  g.addEdge("S2", "M", 7);
  g.addEdge("M", "T1", 1);
  g.addEdge("M", "T2", 3);
  const r = g.compute();
  assert.ok(r.ok);
  assert.equal(r.duration, 10); // S2->M->T2
  assert.deepEqual(criticalKeys(r.criticalEdges), [
    "M->T2",
    "S2->M",
    `T2->${EXIT}`,
  ]);
  // 非关键汇点 T1 的 LS 仍为总工期（虚拟出口零耗时），但有浮动
  assert.equal(r.latestStart.get("T1"), 10);
  assert.equal(r.earliestStart.get("T1"), 8);
});

test("最长路径证书：内容正确且通过校验", () => {
  const g = buildClassic();
  const r = g.compute();
  assert.ok(r.ok);
  assert.deepEqual(r.certificate.nodes, ["A", "C", EXIT]);
  assert.deepEqual(r.certificate.weights, [5, 0]);
  assert.equal(r.certificate.totalDuration, 5);
  assert.ok(g.verifyCertificate(r.certificate));
  // 篡改证书应校验失败
  assert.ok(!g.verifyCertificate({ nodes: ["B", "C", EXIT], weights: [3, 0], totalDuration: 3 }));
  assert.ok(!g.verifyCertificate({ nodes: ["A", "C", EXIT], weights: [4, 0], totalDuration: 4 }));
  assert.ok(!g.verifyCertificate({ nodes: ["A", "D", "C", EXIT], weights: [2, 1, 0], totalDuration: 3 }));
});

test("增量更新：修改工期后与全拓扑重算一致", () => {
  const g = buildClassic();
  g.compute();
  // 让 B->C 变成关键路径
  g.setWeight("B", "C", 9);
  assert.ok(g.verifyAgainstFullRecompute());
  let r = g.currentResult();
  assert.equal(r.duration, 9);
  assert.deepEqual(criticalKeys(r.criticalEdges), ["B->C", `C->${EXIT}`]);
  assert.ok(g.verifyCertificate(r.certificate));
  // 缩短 A->C，工期不变（B->C 仍为关键）
  g.setWeight("A", "C", 1);
  assert.ok(g.verifyAgainstFullRecompute());
  assert.equal(g.currentResult().duration, 9);
  // 把 B->C 改小，关键路径切回 A->C... A->C=1 太短，工期由 B->C=4 决定
  g.setWeight("B", "C", 4);
  assert.ok(g.verifyAgainstFullRecompute());
  r = g.currentResult();
  assert.equal(r.duration, 4);
  assert.deepEqual(criticalKeys(r.criticalEdges), ["B->C", `C->${EXIT}`]);
  // 零时长修改：A->D 改为 0，再改为大值成为关键
  g.setWeight("A", "D", 0);
  assert.ok(g.verifyAgainstFullRecompute());
  g.setWeight("A", "D", 20);
  assert.ok(g.verifyAgainstFullRecompute());
  r = g.currentResult();
  assert.equal(r.duration, 20);
  assert.deepEqual(criticalKeys(r.criticalEdges), ["A->D", `D->${EXIT}`]);
  assert.ok(g.verifyCertificate(r.certificate));
});

test("增量更新：父指针刷新保证证书在等值情况下仍有效", () => {
  // 两条到 C 的路径等长；缩短 S->A 后 C 的 ES 不变，但取得最大值的父节点从 A 换成 B
  const g = new DagScheduler();
  g.addEdge("S", "A", 1);
  g.addEdge("A", "C", 5);
  g.addEdge("B", "C", 6);
  const r0 = g.compute();
  assert.ok(r0.ok);
  assert.equal(r0.duration, 6);
  assert.deepEqual(r0.certificate.nodes, ["S", "A", "C", EXIT]);
  g.setWeight("S", "A", 0); // C 的 ES 仍为 6，但最长路径改经 B
  assert.ok(g.verifyAgainstFullRecompute());
  const r = g.currentResult();
  assert.ok(g.verifyCertificate(r.certificate));
  assert.equal(r.certificate.totalDuration, 6);
  assert.deepEqual(r.certificate.nodes, ["B", "C", EXIT]);
});

test("环检测：返回最短环", () => {
  const g = new DagScheduler();
  g.addEdge("n1", "n2", 1);
  g.addEdge("n2", "n3", 1);
  g.addEdge("n3", "n1", 1); // 长度 3 的环
  g.addEdge("n4", "n5", 1);
  g.addEdge("n5", "n4", 1); // 长度 2 的环（更短）
  g.addEdge("n1", "n4", 1); // 连接边，非环
  const r = g.compute();
  assert.ok(!r.ok);
  assert.equal(r.cycle.length, 3); // 首尾相同：2 条边 + 回到起点
  assert.equal(r.cycle[0], r.cycle[2]);
  assert.deepEqual(new Set(r.cycle.slice(0, 2)), new Set(["n4", "n5"]));
});

test("环检测：自环", () => {
  const g = new DagScheduler();
  g.addEdge("x", "x", 0);
  const r = g.compute();
  assert.ok(!r.ok);
  assert.deepEqual(r.cycle, ["x", "x"]);
});

test("无环图 findShortestCycle 返回 null", () => {
  const g = buildClassic();
  assert.equal(g.findShortestCycle(), null);
});

test("非法输入：负权重与重复边", () => {
  const g = new DagScheduler();
  g.addEdge("a", "b", 1);
  assert.throws(() => g.addEdge("a", "c", -1));
  assert.throws(() => g.addEdge("a", "b", 2));
  assert.throws(() => g.setWeight("a", "zzz", 1));
});

// ---------------- 随机化对照测试 ----------------

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

test("随机 DAG：增量更新与全拓扑重算始终一致", () => {
  const rand = mulberry32(20261008);
  for (let trial = 0; trial < 30; trial++) {
    const n = 5 + Math.floor(rand() * 20);
    const g = new DagScheduler();
    const edges: Array<[string, string]> = [];
    for (let i = 0; i < n; i++) g.addNode(`v${i}`);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (rand() < 0.25) {
          const w = Math.floor(rand() * 6); // 含 0，验证零时长边
          g.addEdge(`v${i}`, `v${j}`, w);
          edges.push([`v${i}`, `v${j}`]);
        }
      }
    }
    const r0 = g.compute();
    assert.ok(r0.ok);
    assert.ok(g.verifyCertificate(r0.certificate));
    // 多轮随机修改工期，每轮都与全量重算对照
    for (let round = 0; round < 15 && edges.length > 0; round++) {
      const [u, v] = edges[Math.floor(rand() * edges.length)]!;
      g.setWeight(u, v, Math.floor(rand() * 8));
      assert.ok(g.verifyAgainstFullRecompute(), `trial=${trial} round=${round}`);
      const r = g.currentResult();
      assert.ok(g.verifyCertificate(r.certificate), `cert trial=${trial} round=${round}`);
      // 证书路径上每条边都应是关键边
      const keys = new Set(r.criticalEdges.map((e) => `${e.from}->${e.to}`));
      for (let i = 0; i + 1 < r.certificate.nodes.length; i++) {
        assert.ok(
          keys.has(`${r.certificate.nodes[i]}->${r.certificate.nodes[i + 1]}`),
          `证书边不在关键边集合中 trial=${trial} round=${round}`,
        );
      }
    }
  }
});

test("随机含环图：最短环长度正确", () => {
  const g = new DagScheduler();
  // 环1: a->b->c->d->a（长 4）；环2: a->b->a（长 2）
  g.addEdge("a", "b", 1);
  g.addEdge("b", "c", 1);
  g.addEdge("c", "d", 1);
  g.addEdge("d", "a", 1);
  g.addEdge("b", "a", 1);
  const r = g.compute();
  assert.ok(!r.ok);
  assert.equal(r.cycle.length - 1, 2);
});
