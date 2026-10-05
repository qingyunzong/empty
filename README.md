# call-tree-limiter

函数执行库：为**整条调用树**限制在途（in-flight）执行数。纯 TypeScript +
Node.js 内置库（`node:test` / `node:assert` / `setImmediate`），零 npm 依赖。

## 语义

- 整棵树共享同一个容量预算 `capacity`，与嵌套深度无关。
- 帧（frame）的函数体运行时必须持有一个占位（slot）。
- 父函数 `await ctx.spawn(child)` 时**交还占位**，子任务因此总能获得占位，
  所以嵌套深度超过容量也能完成（容量为 1 时任意深度均可完成）。
- 父函数恢复前必须**重新申请占位**（成功与异常路径都重新申请）。
- 返回或抛出都会释放帧占位：异常沿树传播时逐帧 `finally` 清理，
  最终 `inFlight === 0`、`waiting === 0`，树可继续复用。
- 占位按 FIFO 通过 `Scheduler` 授予；释放时直接把占位**移交**给队首等待者
  （在途数不变），新申请者无法插队，并行预算永不超限。

## 手动调度器验收

`ManualScheduler` 把所有占位授予排队，由测试逐步驱动（`step()` / `drain()`）。
若调度器队列清空而被测 promise 仍未 settle，即判定死锁——容量 1 的深度嵌套
用例正是靠这一点证明"await 子任务时交还占位"：不交还就必然死锁、测试失败。

## 运行

```sh
npm test   # tsc 编译到 dist/ 后用 node:test 逐个执行测试文件
```

## 实际测试结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

```
TAP version 13
# Subtest: 嵌套深度超过容量仍能完成且不超并行预算（深度 12，容量 2）
ok 1 - 嵌套深度超过容量仍能完成且不超并行预算（深度 12，容量 2）
# Subtest: 容量为 1 时任意深度仍可完成（await 子任务必须交还占位）
ok 2 - 容量为 1 时任意深度仍可完成（await 子任务必须交还占位）
# Subtest: 父函数恢复时重新申请占位（acquire 计数 = 帧数 + 恢复数）
ok 3 - 父函数恢复时重新申请占位（acquire 计数 = 帧数 + 恢复数）
# Subtest: 异常沿调用树传播时清理全部占位
ok 4 - 异常沿调用树传播时清理全部占位
# Subtest: 并发扇出不超并行预算（容量 3，3 叉扇出深度 3）
ok 5 - 并发扇出不超并行预算（容量 3，3 叉扇出深度 3）
# Subtest: 默认调度器（setImmediate）下也能跑通
ok 6 - 默认调度器（setImmediate）下也能跑通
1..6
# tests 6
# pass 6
# fail 0
# duration_ms 48.126603
```

退出码 0，6/6 通过。

## 文件

- `src/call-tree.ts` — `CallTree`（容量/占位/FIFO 授予）与 `runTree`/`spawn` 执行语义
- `src/scheduler.ts` — `Scheduler` 接口、`ManualScheduler`、默认 `immediateScheduler`
- `test/call-tree.test.ts` — 手动调度器验收用例
- `types/node-shim.d.ts` — 离线环境下的最小 Node 内置模块类型声明
