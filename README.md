# dag-critical-path

DAG 关键路径调度库（TypeScript）：

- 每个节点的最早开始（ES）/ 最晚开始（LS）与总工期（makespan）
- 全部关键边：双向紧绷（`ES[u]+w == ES[v]` 且 `LS[u]+w == LS[v]`）
- 多个终点视为连接到共同的零耗时虚拟出口 `__exit__`
- 零时长边合法，可参与关键路径
- 修改单条边工期后**增量更新** ES/LS，并与全拓扑重算自动对照
- 输出最长路径证书（从源点到出口的紧绷边链，边权和等于总工期）
- 图中有环时抛出 `CycleError`，报告**最短环**（边数最少）

## 使用

```ts
import { DagScheduler, EXIT_NODE } from "./src/dag.js";

const g = new DagScheduler();
g.addEdge("A", "B", 3);
g.addEdge("A", "C", 2);
g.addEdge("B", "D", 4);
g.addEdge("C", "D", 1);
g.addEdge("D", "E", 2);

const s = g.recompute();
s.makespan;                    // 9
s.earliestStart.get("D");      // 7
s.latestStart.get("C");        // 6（C 有 4 单位松弛）

g.criticalEdges();             // A->B, B->D, D->E, E->__exit__
g.longestPathCertificate();    // { path: [A, B, D, E, __exit__], totalDuration: 9 }

// 增量更新：只传播受影响子图，并返回与全量重算的对照结果
const { schedule, verification } = g.updateDuration("C", "D", 10);
schedule.makespan;             // 14
verification.consistent;       // true（与全拓扑重算一致）
```

## 测试

```sh
npm test   # tsc 编译后运行 node:test 测试（14 个用例）
```

环境说明：本仓库不依赖任何 npm 包；`tsc` 需可用（`npm i -g typescript`），
Node >= 18 即可运行编译产物。`test/node-shims.d.ts` 是 `node:test` /
`node:assert` 的最小类型声明，用于无 `@types/node` 的离线环境。
