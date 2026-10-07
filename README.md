# reachable-graph

TypeScript 有向图库：增删边、可达性查询、最短路径（平局取字典序最小节点序列）、
原子批量修改、自环、按源 BFS 缓存与受影响源失效。

## 用法

```ts
import { DirectedGraph } from "./src/graph";

const g = new DirectedGraph();
g.addEdge("a", "b");
g.applyBatch([
  { type: "add", from: "b", to: "c" },
  { type: "add", from: "c", to: "c" }, // 自环允许
]);

g.isReachable("a", "c");      // true
g.reachableFrom("a");         // ["a", "b", "c"]
g.shortestPath("a", "c");     // ["a", "b", "c"]

const { affectedSources } = g.removeEdge("b", "c"); // ["a", "b"]，缓存同步失效
```

## 语义

- **原子批量**：`applyBatch` 先在副本上校验并应用全部操作，任一失败则抛出
  `BatchValidationError`，原图不变；成功后整体换入。批内操作按顺序生效，
  重复加边为无操作，删除不存在的边报错。
- **受影响源集合**：对每条触及的边 `u -> v`，凡在修改前能到达 `u` 的源点
  （含 `u` 自身）其可达集都可能变化，全部计入 `affectedSources` 并从缓存中逐出。
  该集合是保守且可靠的（实际变化的源是其子集）。
- **最短路径平局**：先取长度最短，并列时取节点序列字典序最小者。
  `shortestPath(x, x)` 恒为 `[x]`（长度 0），与自环无关。

## 测试

```sh
npm test   # tsc 编译 + node --test
```

测试含 200 轮随机模糊：先以查询填充缓存，再施加含删边的随机批量修改，
断言“实际可达集发生变化的源 ⊆ affectedSources”，并将所有
`reachableFrom` / `shortestPath` 结果与无缓存的逐起点 BFS /
暴力枚举参考实现（`src/reference.ts`）逐一比对。
