# dep-test-executor

依赖图测试执行库（TypeScript + Node.js 内置库，零运行时依赖）。

## 语义

- **环隔离**：用 Tarjan 算法求 SCC。大小 > 1 的 SCC 或自环构成环；
  只隔离环成员及其全部传递后继（依赖环的用例），其余用例照常可执行。
- **失败传播**：某用例失败时，仅取消其传递后继（`cancelled`），
  不跳过兄弟分支——独立分支和同层兄弟照常执行。
- **稳定输出**：结果与启动集合均按用例 ID 字典序排序，与输入顺序无关。
- **模型核对**：`verifyAgainstModel` 用全图分类模型（`src/model.ts`，
  对整图一次性分类）核对可控执行器的启动集合与每个用例状态，两者必须一致。

## 状态

| 状态 | 含义 |
| --- | --- |
| `passed` / `failed` | 实际执行并通过 / 失败 |
| `cancelled` | 因祖先失败（或取消）而未执行 |
| `isolated` | 属于环 SCC 或环的后继，未执行 |

## 结构

- `src/graph.ts` — SCC（Tarjan）、环及后继隔离计算
- `src/executor.ts` — 可控执行器（注入 `run(id) => boolean` 决定结果）
- `src/model.ts` — 全图分类模型与期望启动集合
- `src/verify.ts` — 执行器与模型的交叉核对
- `test/executor.test.ts` — 单元测试 + 200 组种子随机图交叉核对
- `examples/demo.ts` — 演示

## 命令

```sh
npm test        # 编译并运行测试
npm run demo    # 运行演示
npm run typecheck
```

说明：本机 Node v22.22.1 未内置 TypeScript 支持，故 `npm test` 先用
`tsc` 编译到 `dist/` 再以 `node --test` 运行；仅使用 Node 内置模块
（`node:test`、`node:assert`），`types/node.d.ts` 为最小类型声明。

## 实际运行结果（2026-10-05，Node v22.22.1）

`npm test` 退出码 0（`node --test` 顶层按文件汇总为 1 项）；测试文件
进程内 9 个子测试全部通过：

```
ok 1 - cycle: only the SCC and its successors are isolated, the rest execute
ok 2 - cycle: upstream dependencies of a cycle still execute
ok 3 - cycle: self-loop is isolated
ok 4 - failure: cancels successors transitively but never siblings
ok 5 - failure: one failing root does not stop an independent branch
ok 6 - results: stably sorted by id regardless of input order
ok 7 - validation: unknown dependency and duplicate id throw
ok 8 - model: classification agrees with executor on a hand-built graph
ok 9 - cross-check: executor started set matches full-graph model on random graphs
# tests 9
# pass 9
# fail 0
```

其中第 9 项为 200 组种子随机图（含环、自环、随机失败）的
执行器 ↔ 全图模型启动集合与状态一致性核对。

`npm run demo`（auth 失败，report-a/b/c 成环）：

```
Results (sorted by id):
  auth           failed
  cart           cancelled
  checkout       cancelled
  report-a       isolated
  report-b       isolated
  report-c       isolated
  report-export  isolated
  search         passed
Started: auth, search
Model cross-check: OK
```
