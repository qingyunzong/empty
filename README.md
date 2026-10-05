# retry-query

查询库：超时请求按固定延迟表重试，全部行为由虚拟钟驱动，零依赖（仅 Node.js 内置模块）。

## 语义

- **超时重试**：每次尝试有独立超时（`timeout`），超时后按固定表 `delays` 依次等待并重试；表耗尽则以 `TimeoutError` 拒绝。
- **代际隔离**：每次尝试有递增的 generation。超时的当 tick 即将旧代作废，旧代的迟到成功/失败一律忽略，不得覆盖新代结果——即使迟到事件落在重试延迟窗口内。
- **取消**：`cancel()` 终止当前在飞的尝试（调用其 `AttemptHandle.cancel()`）、清除超时与重试定时器，以 `CancelledError` 拒绝；之后不再发起任何尝试。
- **同 tick 决胜**：虚拟钟按 `(time, seq)` 排序触发事件；模拟超时与成功落在同一 tick 时，按事件调度顺序决胜。库在派发尝试之后才武装超时定时器，因此操作内同步调度的同 tick 成功先于超时；超时武装之后才调度的同 tick 成功则判负。
- **唯一交付**：返回的 Promise 恰好 settle 一次（`settled` 守卫 + 清理定时器）。

## 结构

- `src/clock.ts` — `VirtualClock`：确定性虚拟钟，同 tick 按调度序触发。
- `src/query.ts` — `runQuery(operation, { clock, timeout, delays })`：返回 `{ promise, cancel() }`。
- `test/` — `node:test` 测试，核对调用次数、尝试起始时刻与唯一交付。

## 运行

```sh
npm test   # tsc 编译到 dist/ 后运行 node --test
```

## 实际测试结果（2026-10-06，Node v22.22.1，tsc 7.0.2）

`npm test` 通过：2 个文件、13 个用例全部 ok。

`dist/test/clock.test.js`：

```
ok 1 - same-tick events fire in scheduling order
ok 2 - event scheduled during a same-tick callback runs after queued peers
ok 3 - clearTimeout prevents firing
```

`dist/test/query.test.js`：

```
ok 1 - first-attempt success: one call, one delivery
ok 2 - retries follow the fixed delay table
ok 3 - stale late success does not overwrite the new generation result
ok 4 - same tick, success scheduled first: success wins, no retry
ok 5 - same tick, timeout scheduled first: timeout wins, retry happens
ok 6 - stale success during the retry-delay window is ignored
ok 7 - cancel while attempt in flight terminates it and ignores late success
ok 8 - cancel during retry delay stops all further attempts
ok 9 - exhausting the delay table rejects with TimeoutError
ok 10 - exactly one delivery even with many stale events
```

汇总：`# pass 2 / # fail 0`（文件级），用例级 13/13 通过。
