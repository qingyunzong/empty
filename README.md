# det-async-scheduler

确定性异步测试调度库（TypeScript + Node.js 内置库，零运行时依赖）。

## 特性

- **await 边界即调度事件**：`ctx.checkpoint()` / `ctx.sleep(ms)` 等每个 await
  边界都会注册为 `register` 事件（边界 id 如 `worker-a#2`），进入可调度集合。
- **种子选调度**：每个调度步用种子化 PRNG（mulberry32，状态可序列化）从
  ready 集合中选一个边界恢复执行；同一种子产生完全相同的轨迹。
- **全量顺序记录**：`register / schedule / complete / cancel / timeout`
  全部按 `seq` 顺序记入轨迹；`schedule` 事件附带当时的完整 ready 集合。
- **回放校验**：`setReplay(trace)` 后运行，逐步比对事件；ready 事件集合
  不匹配、被选事件不符、轨迹有剩余事件，都会抛出 `ReplayMismatchError`。
- **分段快照**：`snapshot()` 含 `rngState`（随机状态）、虚拟时间、pending
  边界集合；`Scheduler.restore()` 重放前缀重建状态并校验快照，继续运行的
  分段轨迹与完整运行的逐步轨迹完全一致。

## 结构

- `src/prng.ts` — mulberry32 PRNG，`getState()/setState()` 可序列化随机状态
- `src/scheduler.ts` — `Scheduler`、`TaskContext`、`Snapshot`、`ReplayMismatchError`
- `test/scheduler.test.ts` — 11 个测试（`node:test` + `node:assert/strict`）
- `types/node-shims.d.ts` — 环境无网络，为所用 Node 内置模块提供最小类型声明

## 运行

```sh
npm test   # tsc 编译到 dist/ 后用 node --test 运行
```

## 实际测试结果

环境：Node.js v22.22.1，TypeScript 7.0.2，2026-10-06 执行。

```
ok 1 - await boundaries are registered as schedulable events
ok 2 - seed selects the schedule: same seed identical, other seeds diverge
ok 3 - completion, cancellation and timeout orderings are all recorded
ok 4 - replay of a recorded trace reproduces it exactly
ok 5 - replay rejects a mismatched chosen event
ok 6 - replay rejects a mismatched ready event set
ok 7 - replay rejects leftover and divergent traces
ok 8 - segmented snapshots carry RNG state and match the full run's trace
ok 9 - restore rejects a snapshot that does not match the trace prefix
ok 10 - timeout rejects the boundary promise with TimeoutError
ok 11 - cancel rejects the pending boundary with CancelledError and can be caught
# tests 11
# pass 11
# fail 0
```

## 用法示例

```ts
import { Scheduler, TimeoutError } from "./src";

const scheduler = new Scheduler({ seed: 42 });
scheduler.spawn("worker", async (ctx) => {
  await ctx.checkpoint("init");          // 注册 await 边界
  await ctx.sleep(10);                   // 虚拟时间睡眠
  try {
    await ctx.sleep(20, { timeout: 12 }); // 超时竞速
  } catch (err) {
    if (!(err instanceof TimeoutError)) throw err;
  }
});
const trace = await scheduler.run();      // 完整事件轨迹

// 回放：事件集合不匹配会抛 ReplayMismatchError
const replayer = new Scheduler({ seed: 42 });
/* ...spawn 相同任务... */
replayer.setReplay(trace);
await replayer.run();
```
