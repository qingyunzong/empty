# DAG 关键路径调度器

TypeScript 实现的项目库工期计算：正推/反推求每个节点的最早开始（ES）与最晚开始（LS），
枚举全部关键边，输出可校验的最长路径证书；修改工期后做增量更新，并可与全拓扑重算对照；
图中含环时报告最短环。

## 语义约定

- **多个终点**：所有汇点视为经零耗时虚拟边连到共同出口 `EXIT`，故每个汇点的 LS 都等于总工期。
- **零时长边合法**：权重允许为 0（必须是非负有限数），零时长边同样可成为关键边。
- **关键边**：边 `u->v` 为关键边当且仅当 `ES[u]==LS[u]`、`ES[v]==LS[v]` 且 `ES[u]+w==ES[v]`；
  另含关键汇点到 `EXIT` 的虚拟零耗时边。

## API 摘要（`src/critical-path.ts`）

- `addNode(id)` / `addEdge(from, to, weight)` / `setWeight(from, to, weight)`：建模与改工期。
- `compute()`：全拓扑重算；有环时返回 `{ ok: false, cycle }`，`cycle` 为最短环（首尾相同的节点序列）。
- `setWeight(...)`：已计算过时自动走**增量更新**——仅沿拓扑序重算受影响下游的 ES、
  受影响上游的 LS（值未变即停止扩散；总工期变化时同步刷新汇点 LS）。
- `currentResult()`：`{ duration, earliestStart, latestStart, criticalEdges, certificate }`。
- `verifyAgainstFullRecompute()`：克隆全量重算，逐项对照增量结果（工期 / ES / LS / 关键边集合）。
- `verifyCertificate(cert)`：校验最长路径证书——边真实存在、权重吻合、权值总和等于总工期。

## 运行测试

```sh
npm test   # tsc 编译 + node --test 运行 dist/test/*.test.js
```

环境要求：Node.js（内置 `node:test`）与 `tsc`（TypeScript）。无需安装任何 npm 依赖；
`types/node-shims.d.ts` 提供了 `node:test` / `node:assert` 的最小类型声明。

## 示例

```ts
import { DagScheduler, EXIT } from "./src/critical-path.js";

const g = new DagScheduler();
g.addEdge("A", "C", 5);
g.addEdge("B", "C", 3);
g.addEdge("A", "D", 2);

const r = g.compute();          // r.ok === true, r.duration === 5
// 关键边: A->C 与 C->EXIT（虚拟零耗时边）

g.setWeight("B", "C", 9);       // 增量更新
g.verifyAgainstFullRecompute(); // true：与全量重算一致
g.currentResult().certificate;  // { nodes: ["B","C","__EXIT__"], weights: [9,0], totalDuration: 9 }
```
