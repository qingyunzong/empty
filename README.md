# coalesce

按键（key）共享进行中计算的请求合并库。TypeScript 编写，仅使用 Node.js 内置模块
（`node:test` / `node:assert` / 内置定时器），零运行时依赖。

## 语义

- **按键合并**：同一 key 的并发 `run()` 共享一次计算，所有等待者拿到同一结果；
  不同 key 互不影响。后加入者的 `compute` 参数不会被调用。
- **独立取消**：每个等待者持有独立 `Handle`，`cancel()` 只拒绝自己的 promise
  （`CancelledError`），不影响其他等待者；**全部**等待者取消时才通过
  `AbortSignal` 中止底层计算，并拆除该代（generation）。
- **失败限时缓存**：计算失败后按 key 缓存错误 `failureTtlMs`（调度器时间，可用
  虚拟时钟），期间同 key 调用直接得到缓存错误、不再触发计算；到期自动驱逐。
  成功不缓存。`failureTtlMs <= 0` 关闭缓存。
- **代际防复活**：完成与最后一次取消交错时，迟到的结果/失败会被代际检查
  （`inflight.get(key) !== entry`）整体丢弃——既不会覆盖同 key 的新一代，
  也不会写入失败缓存，旧代永不复活。

## 结构

- `src/coalesce.ts` — `Coalescer` 核心（`run` / `cancel` / `callCount` / 失败缓存）
- `src/scheduler.ts` — `Scheduler` 抽象；`SystemScheduler`（真实时钟）与
  `ManualScheduler`（可控执行器：虚拟时钟，`advance(ms)` 手动推进）
- `test/coalesce.test.ts` — 11 个用例，用 `ManualScheduler` 做确定性验证，
  每个用例通过 `t.diagnostic` 输出 compute 实际调用次数
- `types/node.d.ts` — 所用 Node 内置 API 的最小 ambient 声明（环境无
  `@types/node`，离线）

## 用法

```ts
import { Coalescer } from './src/coalesce.js';

const c = new Coalescer({ failureTtlMs: 1000 }); // 默认真实定时器

const h1 = c.run('user:1', (signal) => fetchUser('1', signal));
const h2 = c.run('user:1', (signal) => fetchUser('1', signal)); // 共享同一次计算
h1.cancel();                        // 只取消 h1；h2 仍会得到结果
const user = await h2.promise;

console.log(c.callCount);           // 底层 compute 实际调用次数：1
```

测试中注入可控执行器：

```ts
import { ManualScheduler } from './src/scheduler.js';
const scheduler = new ManualScheduler();
const c = new Coalescer({ failureTtlMs: 1000, scheduler });
// ... 失败后
scheduler.advance(1000);            // 虚拟时间推进，失败缓存到期
```

## 构建与测试

```sh
npm test    # tsc 编译到 build/ 后用 node --test 运行
```

环境要求：Node.js（内置 test runner）与 `tsc`（本仓库以 TypeScript 7.0.2 验证）。

## 实测结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

`npm test` 退出码 0。编译产物直接运行的详细输出（含各用例 compute 调用次数）：

```
    ok 1 - shares one computation among concurrent waiters of the same key
    # 3 waiters / 1 key: compute calls = 1, inflight = 0
    ok 2 - does not coalesce across different keys
    # 2 keys: compute calls = 2, inflight = 0
    ok 3 - never invokes the compute argument of a joining waiter
    # joining waiter: compute calls = 1, inflight = 0
    ok 4 - single waiter cancel does not affect the remaining waiters
    # 1 of 2 waiters cancelled: compute calls = 1, inflight = 0
    ok 5 - aborts the computation only when ALL waiters cancel
    # all waiters cancelled, then retry: compute calls = 2, inflight = 0
    ok 6 - cancel is idempotent and a no-op after settlement
    # idempotent cancel: compute calls = 2, inflight = 0
    ok 7 - caches failures only for the configured virtual TTL
    # failure cached @t=0: compute calls = 1, inflight = 0
    # after TTL expiry: compute calls = 2, inflight = 0
    ok 8 - late success after the last cancel does not resurrect the generation
    # late success after cancel: compute calls = 2, inflight = 0
    ok 9 - late failure after the last cancel is NOT written to the failure cache
    # late failure after cancel: compute calls = 2, inflight = 0
    ok 10 - stale completion cannot clobber a newer generation of the same key
    # stale vs new generation: compute calls = 2, inflight = 0
    ok 11 - works with the default real-timer scheduler
    # real scheduler: compute calls = 2, inflight = 0
ok 1 - Coalescer
# tests 11
# pass 11
# fail 0
```
