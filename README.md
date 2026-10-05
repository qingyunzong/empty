# version-delta-merge

订阅合并库：接收版本差量（delta），按声明的父版本组装版本图。仅使用
TypeScript + Node.js 内置库（`node:crypto`、`node:test`、`node:assert`），
无任何运行时依赖。

## 语义

- **父版本声明与缓冲**：每个 delta 声明 `parents`。父版本全部就位则立即
  应用；否则进入缓冲（`buffered`），待父版本到达后自动晋升，乱序到达安全。
- **多分支不强行线性化**：分叉产生多个 head，库不挑选"主线"。查询必须
  显式指定分支头：`graph.history(head)` / `graph.materialize(head, ...)`，
  空 head 或未知 head 直接抛错。
- **坏摘要隔离后继**：`digest` 为 `sha256(canonical({id, parents, payload}))`。
  摘要不匹配的 delta 被隔离（quarantine），其全部后继（包括已缓冲、
  尚未到达的）一并隔离；无亲缘关系的分支不受影响。
- **乱序重放对照完整构建**：`VersionGraph.buildFull(deltas)` 按依赖序
  完整构建版本图；`apply` 按到达序重放。`graph.equals(other)` 比较
  应用集、缓冲集、隔离集、head 集及每个 head 的分支历史，两者必须一致。

## API

```ts
import { VersionGraph, makeDelta } from "./src/index.js";

const graph = new VersionGraph();
graph.apply(makeDelta("r", [], payload));            // applied
graph.apply(makeDelta("b", ["a"], payload));         // buffered（父 a 缺失）
graph.apply(makeDelta("a", ["r"], payload));         // applied，b 自动晋升
graph.heads();                                       // 当前全部分支头
graph.history("b");                                  // 指定分支头的拓扑序历史
graph.materialize("b", init, (state, payload) => ...); // 沿分支折叠状态
VersionGraph.buildFull(deltas);                      // 完整版本图构建（对照用）
```

`apply` 返回状态：`applied | buffered | duplicate | bad-digest | quarantined`。

## 测试

```sh
npm test    # tsc 编译后逐个运行 dist/test/*.test.js
```

说明：本环境沙箱禁止 spawn 子进程，`node --test` 的进程隔离模式不可用，
因此测试脚本直接以 `node` 逐个运行测试文件（`node:test` 进程内运行，
失败时退出码非零）。环境无 npm registry 访问，`@types/node` 无法安装，
`types/node.d.ts` 仅声明实际用到的内置模块接口。

## 实际测试结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

```
ok 1 - digest is deterministic and detects tampering
ok 2 - in-order deltas form a linear chain with a single head
ok 3 - out-of-order deltas are buffered and promoted when parents arrive
ok 4 - branches are not linearized; queries must name a head
ok 5 - merge delta joins two branches into one head
ok 6 - bad digest quarantines the delta and all of its successors
ok 7 - quarantine cascades to successors buffered before the bad parent
ok 8 - out-of-order replay matches full version-graph construction
ok 9 - replay matches full build when a forged delta splits the graph
ok 10 - deltas with parents outside the batch stay buffered in both modes
ok 11 - duplicates are idempotent
# tests 11
# pass 11
# fail 0
```
