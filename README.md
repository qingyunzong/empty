# tree-slot-scheduler

函数执行库：为**整条调用树**限制在途数（同时持有占位的任务数），仅用 TypeScript + Node.js 内置库实现，零运行时依赖。

## 语义

- **整树限额**：`Scheduler({ capacity })` 的容量由整棵调用树共享，任何时刻 `active <= capacity`。
- **await 子任务交还占位**：`ctx.call(fn)` / `ctx.all([...])` 等待子任务前，父任务先 `suspend()` 交还自己的占位，让出的容量立即可被子任务使用——因此嵌套深度超过容量也不会死锁。
- **恢复重新申请**：子任务落定后，父任务 `resume()` 重新排队申请占位，拿到占位才继续执行。
- **异常清理全部占位**：每个任务在 `finally` 中释放占位；`ctx.all` 用 `Promise.allSettled` 等全部子任务落定后再抛出首个错误，异常沿调用链逐层冒泡时所有占位都被释放，无泄漏、无排队残留。

## 手动调度器验收

`Scheduler` 以 `manual: true` 构造时，排队等待占位的续体只能通过显式 `pump()` 获得授权。测试中的 `drive()` 帮助函数每轮先 `pump()` 再让出事件循环，手动驱动整棵树直到完成，同时调度器记录 `active` / `maxActive` / `totalAcquired` / `totalReleased` 供断言。

## 运行

```sh
npm test   # tsc 编译后运行 node:test 测试（Node.js 内置 test runner）
```

环境：Node.js v22.22.1，TypeScript 7.0.2（全局 tsc；网络受限，`types/node.d.ts` 为本项目用到的 Node 内置 API 的最小声明）。

## 验收用例与实际结果（2026-10-05 实测）

| # | 用例 | 关键断言 | 结果 |
|---|------|----------|------|
| 1 | 嵌套深度超过容量仍能完成（capacity=1, depth=6） | 结果聚合正确；逐层深入未死锁；`maxActive === 1` | ok |
| 2 | 扇出并发不超并行预算（capacity=3, 12 叶子） | 12 个叶子全部完成；`maxActive <= 3` 且 `=== 3`（预算用满） | ok |
| 3 | 深层子任务抛异常 | 错误原样冒泡；`active === 0`、`pending === 0`、账平 | ok |
| 4 | 恢复必须重新申请占位（capacity=1） | 事件序 parent-start → child-run → parent-resumed；申请/释放各 3 次 | ok |

实际输出：

```
# Subtest: 嵌套深度超过容量仍能完成（capacity=1, depth=6）
ok 1 - 嵌套深度超过容量仍能完成（capacity=1, depth=6）
# Subtest: 扇出并发不超并行预算且用满预算（capacity=3, 12 个叶子）
ok 2 - 扇出并发不超并行预算且用满预算（capacity=3, 12 个叶子）
# Subtest: 深层子任务抛异常：错误冒泡且全部占位被清理
ok 3 - 深层子任务抛异常：错误冒泡且全部占位被清理
# Subtest: 恢复执行必须重新申请占位（capacity=1 时父任务恢复让位于排队者）
ok 4 - 恢复执行必须重新申请占位（capacity=1 时父任务恢复让位于排队者）
1..4
# tests 4
# pass 4
# fail 0
```

## 结构

- `src/scheduler.ts` — 手动调度器：容量、FIFO 等待队列、`pump()`、并发统计
- `src/runtime.ts` — 任务运行时：`TaskContext.call/all`、占位生命周期（enter/suspend/resume/exit）、`runTree`
- `test/scheduler.test.ts` — 手动调度器验收测试
