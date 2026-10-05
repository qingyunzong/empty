# dag-task-executor

依赖图任务执行库（TypeScript + Node.js 内置库，无运行时依赖）。

## 语义

- **按依赖图启动**：节点仅当其全部依赖成功后才可运行。
- **失败局部取消**：某节点失败仅取消其（传递）后继；无关分支继续执行。
- **取消不回退**：取消波到达已成功（或运行中）的节点时不回退其状态。
- **环拒绝**：输入含环（含自环）时抛出 `CycleError`，消息与 `err.cycle`
  均携带环路径，如 `Dependency cycle detected: a -> c -> b -> a`。
- **确定性执行器**：就绪节点按定义顺序派发；每个节点的 `run` 至多启动一次
  （执行器内置不变量校验，重复启动会抛 `ExecutorInvariantError`），
  报告中的 `startOrder` 记录实际启动顺序供核对。

## 用法

```ts
import { execute } from "dag-task-executor";

const report = await execute([
  { id: "a", run: () => 2 },
  { id: "b", deps: ["a"], run: (ctx) => (ctx.outputOf("a") as number) * 3 },
  { id: "c", deps: ["a", "b"], run: () => "done" },
]);

report.results.get("c")!.status; // "succeeded"
report.startOrder;               // ["a", "b", "c"]
```

节点状态：`pending | running | succeeded | failed | cancelled`。
校验错误：`GraphValidationError`（重复 id / 未知依赖）、`CycleError`（环）。

## 测试

```sh
npm test   # tsc 编译后由 node --test 运行
```

## 实际测试结果

环境：Node.js v22.22.1，TypeScript 7.0.2（全局 `tsc`），`npm test` 于
2026-10-06 运行，**12/12 通过**：

```
ok 1 - diamond graph: node runs only after all dependencies succeed
ok 2 - failure cancels only its successors; unrelated branches continue
ok 3 - async rejection is treated as failure and propagates cancellation
ok 4 - node with one failed and one succeeded dependency is cancelled
ok 5 - cancellation reaching a succeeded node does not roll it back
ok 6 - dependency outputs are available to dependents via ctx.outputOf
ok 7 - cycle is rejected with the cycle path
ok 8 - self-dependency is rejected as a cycle
ok 9 - unknown dependency and duplicate id are rejected
ok 10 - deterministic executor: every node starts exactly once, stable order
ok 11 - cancelled nodes never start; started nodes start exactly once
ok 12 - empty graph resolves immediately
# tests 12
# pass 12
# fail 0
```

## 结构

- `src/graph.ts` — 图构建与校验（重复 id、未知依赖、DFS 环检测并给出环路径）
- `src/executor.ts` — 确定性执行器（就绪队列按定义序派发、失败传播取消、
  单节点单次启动不变量）
- `src/index.ts` — 公共导出
- `test/executor.test.ts` — `node:test` 测试
- `types/node-shim.d.ts` — 最小 Node 内置模块类型声明（环境无 `@types/node`）
