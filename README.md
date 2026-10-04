# incremental-compile-cache

一个增量编译缓存库（TypeScript，仅依赖 Node.js 内置模块，零第三方依赖）。

## 核心设计

- **实现摘要 / 公开接口摘要分离**（`src/compiler.ts`）：每个模块解析出两份摘要——
  实现摘要 `implHash`（整个源文件的哈希）与接口摘要 `ifaceHash`（仅 `export` 声明归一化后的哈希）。
- **接口不变仅重编自身**：SCC 批次的输入指纹 = 成员实现摘要 + 外部依赖的*接口*摘要
  （`src/scc.ts`）。依赖只改了实现、接口摘要不变时，指纹不变，依赖方不重编；
  接口摘要变化才沿凝结图（condensation DAG）向外传播，并在接口重新稳定处停止。
- **循环模块作为 SCC 整批发布**（`src/graph.ts`、`src/engine.ts`）：Tarjan 求强连通分量，
  同一 SCC 内的模块永远作为一个批次一起编译、一起发布。
- **旧编译任务需核基线**（`AsyncEngine`，`src/engine.ts`）：异步调度时每个编译任务携带
  调度时刻的输入指纹作为基线；任务完成时重新核对当前状态，基线失配（或 SCC 已解散）
  则丢弃结果并按新基线重排，绝不提交过期产物。
- **随机编辑与全量编译模型核对**（`tests/randomized.test.ts`）：`src/fullModel.ts` 提供
  无缓存的全量编译模型作为基准；确定性 PRNG 驱动随机编辑（改实现/改接口/改依赖/增删模块，
  含成环），同步引擎每步核对、异步引擎在交错编辑与部分任务执行后核对，最终产物必须与
  全量模型逐模块一致。

## 目录

- `src/hash.ts` — sha256（`node:crypto`）
- `src/compiler.ts` — 模块解析：导入、接口、双摘要
- `src/graph.ts` — Tarjan SCC + 凝结图拓扑序
- `src/scc.ts` — 批次分析：接口摘要、输入指纹、发布工件
- `src/engine.ts` — `IncrementalEngine`（同步）与 `AsyncEngine`（任务队列 + 基线核对）
- `src/fullModel.ts` — 全量编译基准模型
- `tests/` — 单元测试与随机化交叉核对（`node:test`）

## 运行

```sh
npm test        # tsc 编译到 dist/ 后用 node --test 跑测试
npm run typecheck
```

要求：Node.js（开发用 v22.22.1 验证）与 TypeScript 编译器（开发用 tsc 7.0.2 验证）。
运行时零依赖；`types/node.d.ts` 为所用 `node:*` 内置模块的最小类型声明。

## 实际测试结果

在本环境（Node v22.22.1，tsc 7.0.2）执行 `npm test` 的实际输出：

```
# Subtest: dist/tests/engine.test.js
ok 1 - dist/tests/engine.test.js
# Subtest: dist/tests/randomized.test.js
ok 2 - dist/tests/randomized.test.js
# tests 2
# pass 2
# fail 0
```

逐条用例（全部通过）：

```
ok - interface-unchanged edit recompiles only the edited module
ok - interface change propagates to dependents until interfaces stabilize
ok - initial publish batches the cycle together
ok - editing one member republishes the whole cycle, dependents untouched
ok - interface change inside the cycle reaches external dependents
ok - a task scheduled before a newer edit is discarded, never committed
ok - a task whose SCC dissolved is dropped
ok - synchronous incremental engine            (20 种子 × 60 步随机编辑逐步核对)
ok - async engine with interleaved edits and stale baselines  (15 种子 × 80 步交错核对)
```

`npm run typecheck`（`tsc --noEmit`，strict 模式）通过，无错误。
