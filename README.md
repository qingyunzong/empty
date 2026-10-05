# tx-int-state

整数状态脚本操作库：嵌套保存点、异常捕获、外部动作暂存、操作预算。
使用 TypeScript 编写，运行时仅依赖 Node.js 内置模块（`node:test`、`node:assert`），
并通过随机小程序与复制栈模型（copy-stack model）做差分对照测试。

## 语义

- **嵌套保存点**：`begin()` 打开一层保存点；`commit()` / `rollback()` 关闭最内层。
- **内层回滚只撤本层**：`rollback()` 只撤销本层内的写操作与暂存动作。
- **内层提交并入外层**：`commit()` 把本层的撤销日志与暂存动作并入父层。
- **外层提交才发布动作**：`stage(action)` 暂存的外部动作仅在最外层提交时发布
  （进入 `published`，可用 `drainPublished()` 取走）。
- **异常捕获**：`capture(fn)` 在保存点中执行 `fn`；出错时回滚到进入时的深度并返回
  `{ ok: false, error }`，成功时逐层提交到进入时的深度并返回 `{ ok: true }`。
- **预算终止全撤**：每次 `set/add/mul/stage` 消耗 1 单位预算；预算耗尽抛出
  `BudgetExhaustedError`，该异常会穿透 `capture`，导致 `run()` 回滚所有已打开层，
  未发布的暂存动作全部丢弃（已发布动作不可撤回）。
- **整数约束**：变量值、增量、因子及运算结果必须是安全整数，否则抛 `IntegerError`。

## 实现

- `src/transaction.ts` — `UndoLogMachine`：基于每层撤销日志的事务机（正式实现）。
- `src/model.ts` — `CopyStackModel`：每层整体复制状态的朴素参照模型（差分测试 oracle）。
- `src/random.ts` — 带种子的随机程序生成器与执行器，产出可比较的 `Outcome`
  （最终状态、已发布动作、捕获记录、剩余预算、深度、错误类别）。
- `src/transaction.test.ts` — 15 个语义单元测试。
- `src/differential.test.ts` — 500 个随机程序（种子 0..499）的差分对照测试
  及特征覆盖非空检验。

## 运行

```sh
npm test   # tsc 编译到 dist/ 后用 node --test 运行全部测试
```

环境要求：Node.js（开发环境为 v22.22.1）与 TypeScript 编译器（开发环境为 tsc 7.0.2）。
无第三方运行时依赖。

## 实际测试结果（2026-10-05，Node v22.22.1 + tsc 7.0.2）

`npm test` 输出摘要：

```
# Subtest: dist/differential.test.js
ok 1 - dist/differential.test.js
# Subtest: dist/transaction.test.js
ok 2 - dist/transaction.test.js
# tests 2
# pass 2
# fail 0
```

逐测试明细（18 个全部通过）：

```
ok 1 - inner rollback undoes only its own layer
ok 2 - inner commit merges into parent; outer rollback undoes inner writes
ok 3 - deeply nested savepoints unwind layer by layer
ok 4 - capture rolls back its layer and reports the error
ok 5 - capture commits its layer when the body succeeds
ok 6 - capture restores the entry depth even if the body leaks savepoints
ok 7 - staged actions publish only on the outermost commit
ok 8 - actions staged in a failed capture are discarded
ok 9 - budget exhaustion aborts the run and rolls back everything
ok 10 - budget exhaustion propagates through capture
ok 11 - operations without an open transaction fail
ok 12 - non-integer values and overflowing results are rejected
ok 13 - run auto-commits frames left open by the body
ok 14 - mid-run root commit publishes; a later abort cannot unpublish it
ok 15 - run cannot be nested and drainPublished empties the log
ok 1 - random programs 0..249: undo-log machine matches copy-stack model
ok 2 - random programs 250..499: undo-log machine matches copy-stack model
ok 3 - generated programs exercise every feature (non-vacuous differential test)
```

差分测试特征覆盖（500 个随机程序，共 17395 条顶层操作，两种实现结果完全一致）：

| 特征 | 程序数 |
| --- | --- |
| 预算耗尽全撤（`BudgetExhaustedError`） | 133 |
| 含 `capture` 块 | 443 |
| 捕获到异常 | 373 |
| 有动作被发布 | 290 |
| 正常完整提交 | 233 |
| 事务错误路径（`TransactionError`） | 134 |
