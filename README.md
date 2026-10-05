# dag-executor

按依赖图（DAG）调度任务的 TypeScript 执行库，仅使用 Node.js 内置模块，零运行时依赖。

## 语义

- **按依赖图启动**：节点只有在其**全部**依赖成功（`succeeded`）后才会运行。
- **失败只取消后继**：某节点失败（同步抛出或 Promise reject）时，仅取消其尚未进入终态的传递后继；无关分支继续执行。
- **取消不回退**：取消传播到已成功/已失败的终态节点时直接跳过，已成功的节点不会回退。
- **环拒绝**：输入含环（含自环）时抛出 `CycleError`，`err.cycle` 与 `err.message` 均携带完整环路径（如 `a -> c -> b -> a`）。
- **确定性执行**：`Executor` 按固定拓扑序（Kahn 算法 + 就绪集合按 id 排序）逐个串行执行，每个节点最多启动一次；`ExecutionResult.started` 记录实际启动顺序，可用于核对。

## API

```ts
import { Executor } from "dag-executor";

const result = await new Executor([
  { id: "fetch", run: async () => { /* ... */ } },
  { id: "parse", deps: ["fetch"], run: () => { /* ... */ } },
  { id: "cache", run: () => { /* 无关分支，fetch 失败也会继续 */ } },
]).run();

result.statuses.get("parse"); // "cancelled"（若 fetch 失败）
result.started;               // 实际启动顺序，每个 id 至多出现一次
result.errors.get("fetch");   // 失败原因
```

- `buildGraph(tasks)`：校验并返回 `deps` / `dependents` / 拓扑序 `order`；重复 id 抛 `DuplicateTaskError`，未知依赖抛 `UnknownDependencyError`。
- `executor.cancel(id)`：手动取消，`pending` 节点及其 pending 传递后继变为 `cancelled`，终态节点不受影响。

## 测试

```
npm test    # tsc 编译后用 node:test 运行 dist/test/*.test.js
```

### 实际结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

```
ok 1 - diamond graph: deps run before dependents, each node starts exactly once
ok 2 - failure cancels only its successors; unrelated branches keep running
ok 3 - node runs only when ALL dependencies succeeded
ok 4 - async rejection marks failure and cancels downstream only
ok 5 - cancellation reaching a succeeded node does not roll it back
ok 6 - manual cancel of a pending node propagates to pending successors only
ok 7 - cycle input is rejected with the cycle path
ok 8 - self-dependency is rejected as a cycle
ok 9 - unknown dependency and duplicate ids are rejected
ok 10 - larger graph: every node starts at most once, failures prune only their subtree
# tests 10
# pass 10
# fail 0
```

## 结构

- `src/graph.ts` — 图构建、环检测（DFS，记录环路径）、确定性拓扑排序
- `src/executor.ts` — 确定性串行执行器、失败/取消传播
- `test/executor.test.ts` — `node:test` + `node:assert/strict` 测试
- `types/node.d.ts` — 离线环境下的最小 Node 内置模块类型声明
