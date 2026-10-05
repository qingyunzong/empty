# query-retry-vclock

带超时重试的查询库：TypeScript 实现，仅依赖 Node.js 内置模块（`node:test`、
`node:assert`），零第三方依赖。

## 语义

- **超时重试**：每次尝试有独立超时（`timeoutMs`），超时后按**固定延迟表**
  `retryDelays` 等待再试；总尝试次数 = 1 + 表长，表耗尽后以
  `QueryTimeoutError` 拒绝。
- **代际围栏**：每次尝试有单调递增的代号（generation）。旧代请求迟到成功
  **不得覆盖**新代结果——迟到的 resolve 在 `gen !== generation` 时被丢弃。
- **取消**：`cancel()` 终止全部当前在飞尝试（逐个 `AbortController.abort()`），
  撤销已排程的重试定时器，promise 以 `QueryCancelledError` 拒绝。
- **虚拟钟**：`VirtualClock` 驱动全部定时；同一 tick 的事件按入队序（FIFO）
  决胜——模拟超时与成功落在同一 tick 时，先入队的事件生效。每个事件处理后
  冲刷微任务，保证 promise 反应在下一事件前完成。
- **唯一交付**：返回的 promise 恰好 settle 一次；`calls` 计数器核对 fetcher
  实际调用次数。

## 运行

```sh
npm test   # tsc 编译到 dist/ 后运行全部测试
```

## 实际测试结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

```
# Subtest: first-attempt success resolves once with one call
ok 1 - first-attempt success resolves once with one call
# Subtest: timeout triggers retry after fixed-table delay
ok 2 - timeout triggers retry after fixed-table delay
# Subtest: late success from stale attempt must not overwrite newer result
ok 3 - late success from stale attempt must not overwrite newer result
# Subtest: exhausted retry table rejects with QueryTimeoutError
ok 4 - exhausted retry table rejects with QueryTimeoutError
# Subtest: cancel during retry wait terminates everything, retry never fires
ok 5 - cancel during retry wait terminates everything, retry never fires
# Subtest: cancel with in-flight attempt aborts it and ignores late response
ok 6 - cancel with in-flight attempt aborts it and ignores late response
# Subtest: same tick: success event enqueued before timeout wins
ok 7 - same tick: success event enqueued before timeout wins
# Subtest: same tick: timeout event enqueued first wins, late success fenced
ok 8 - same tick: timeout event enqueued first wins, late success fenced
# Subtest: unique delivery: cancel after settle is a no-op
ok 9 - unique delivery: cancel after settle is a no-op
1..9
# tests 9
# pass 9
# fail 0
```

## 结构

- `src/clock.ts` — 虚拟钟：`(time, seq)` 排序事件队列，同 tick FIFO 决胜。
- `src/query.ts` — `queryWithRetry`：超时、代际围栏、取消、唯一交付。
- `test/query.test.ts` — 9 个场景，含模拟服务器（按脚本延迟应答/不应答）。
- `types/node-shims.d.ts` — Node 内置模块的最小类型声明（零依赖编译）。
