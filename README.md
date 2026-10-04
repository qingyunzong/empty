# keyed-request-coalescer

按键共享进行中计算的请求合并库。TypeScript 编写，仅依赖 Node.js 内置模块
（测试使用 `node:test` / `node:assert`），无第三方运行时依赖。

## 语义

- **按键共享**：同一 key 的并发 `fetch` 共享同一次底层计算，`compute` 只调用一次。
- **独立取消**：每个等待者拿到独立的 `FetchHandle`；单个 `cancel()` 只拒绝自己的
  promise（`AbortError`），不影响其他等待者；**全部**等待者取消后才通过
  `AbortSignal` 终止底层计算。
- **失败缓存**：失败结果仅按指定的虚拟时长（`errorCacheMs`，时钟可注入）缓存，
  命中时不重复调用 `compute`；成功结果不缓存。
- **代际防护**：最后一次取消与底层完成交错时，迟到的 settle 通过
  `inflight.get(key) !== entry` 代际检查识别为过期（`staleSettlements` 计数），
  既不复活旧代结果，也不写入失败缓存。
- **调用次数**：`stats()` 输出 `calls / joins / failureCacheHits / aborts / staleSettlements`。

## API

```ts
const coalescer = new RequestCoalescer(compute, { errorCacheMs: 100, clock });
const handle = coalescer.fetch("key");   // { promise, cancel }
handle.cancel();                          // 仅取消该等待者
coalescer.stats();                        // 调用次数等计数
```

测试工具：`ManualExecutor`（可控执行器，记录每次调用并手动 resolve/reject）、
`VirtualClock`（虚拟时钟，`advance(ms)` 推进时间）。

## 测试

```
npm test    # tsc 编译 + node --test
```

## 实际测试结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

```
ok 1 - same-key concurrent fetches share one computation
ok 2 - different keys compute independently
ok 3 - one waiter cancelling does not affect the others
ok 4 - computation is aborted only when all waiters cancel
ok 5 - cancel then late resolve: stale generation is not resurrected
ok 6 - resolve queued then last cancel in same tick: still no resurrection
ok 7 - stale rejection after last cancel does not populate the failure cache
ok 8 - failures are cached only for the specified virtual duration
ok 9 - successes are not cached; each later fetch recomputes
ok 10 - cancelling after settlement is a no-op
# tests 10
# pass 10
# fail 0
# duration_ms 148.463724
```

测试中打印的 `stats` 实际输出：

```
stats: { calls: 1, joins: 1, failureCacheHits: 0, aborts: 0, staleSettlements: 0 }   # 共享计算
stats: { calls: 1, joins: 0, failureCacheHits: 0, aborts: 1, staleSettlements: 1 }   # 取消后迟到完成
stats: { calls: 2, joins: 0, failureCacheHits: 2, aborts: 0, staleSettlements: 0 }   # 虚拟时长失败缓存
```
