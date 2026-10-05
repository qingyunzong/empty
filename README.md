# det-async-runtime

确定性异步测试运行时（TypeScript，仅依赖 Node.js 内置模块，零 npm 依赖）。

## 设计

- **await 边界即可调度事件**：任务通过 `TaskCtx` 的原语（`sleep` / `checkpoint` / `join`）
  挂起时，运行时会注册一个待调度事件并记录 `await` 轨迹。每个调度步只交付一个恢复，
  随后用 `setImmediate` 排空微任务队列，因此任务交错完全由调度器控制。
- **种子选调度**：就绪集合中的选择由 mulberry32 PRNG（`src/prng.ts`）驱动，
  种子相同则轨迹逐字节一致；不同种子产生不同交错。虚拟时钟推进休眠/超时定时器。
- **完成、取消、超时顺序记录**：`complete` / `fail` / `cancel` / `timeout` 全部按序
  写入轨迹（`TraceEvent`），取消与超时作为可调度事件经就绪队列交付。
- **回放拒绝事件集合不匹配**：每条选择事件记录当时的候选集合（`candidates`）。
  回放模式逐步比对 kind/task/detail/clock/rngState/candidates，任何分歧
  （包括程序变更、候选集被篡改、轨迹被截断）都抛出 `ReplayMismatchError`。
- **分段快照含随机状态**：`snapshot()` 返回 `{ steps, events, clock, rngState, digest }`，
  其中 `rngState` 是完整 PRNG 状态，`digest` 是轨迹的滚动 FNV-1a 校验。
  `restore()` 校验位置与摘要后恢复时钟与随机流；分段运行（快照 → JSON 序列化 →
  恢复 → 继续）的逐步轨迹与完整运行完全一致。

## 使用

```ts
import { Runtime } from "./src/index.js";

const rt = new Runtime({ seed: 42 });
const worker = rt.spawn("worker", async (ctx) => {
  await ctx.sleep(10, { timeout: 5 }); // 可超时的 await 边界
});
rt.spawn("watcher", async (ctx) => {
  await ctx.sleep(3);
  ctx.cancel(worker);                  // 取消作为可调度事件交付
});
const trace = await rt.run();          // 有序轨迹

const replay = new Runtime({ seed: 42, replay: trace }); // 回放校验
// ...同一程序... 若事件集合不匹配则抛 ReplayMismatchError
```

## 命令

- `npm test`：tsc 编译到 `dist/` 后用 `node:test` 运行全部测试
- `npm run typecheck`：仅类型检查
- `npm run demo [seed]`：打印 seed=42（默认）的完整轨迹表、回放与分段恢复验证

## 实际测试结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

`npm test`：

```
# Subtest: dist/test/runtime.test.js
ok 1 - dist/test/runtime.test.js
# tests 1
# pass 1
# fail 0
```

文件内 10 个用例全部通过：

```
ok 1 - deterministic: same seed yields byte-identical traces
ok 2 - seed selects the schedule: different seeds interleave differently
ok 3 - completion, cancellation and timeout order is recorded
ok 4 - replay accepts a matching trace and reproduces it exactly
ok 5 - replay rejects when the program registers a different event set
ok 6 - replay rejects a tampered candidate set
ok 7 - replay rejects a truncated trace
ok 8 - segmented snapshots carry RNG state and match the full run step by step
ok 9 - restore rejects a snapshot from a diverged trace
ok 10 - golden trace for seed 42 is stable
# tests 10
# pass 10
# fail 0
```

`npm run demo` 摘要（seed=42，46 个事件、15 个调度步）：

```
replay: OK (event sets matched)
segments: restored at step 7 (rngState=4231026141, digest=8c9659ed); trace identical to full run: true
```

## 结构

- `src/prng.ts` — 可序列化状态的 mulberry32 PRNG
- `src/runtime.ts` — 调度器、事件注册、轨迹记录/回放、快照/恢复
- `src/trace.ts` — 轨迹事件与快照类型、FNV-1a 摘要
- `src/errors.ts` — `CancelError` / `TimeoutError` / `DeadlockError` / `ReplayMismatchError`
- `test/program.ts` — 共享工作负载（动态 spawn、sleep、join、取消、超时）
- `test/runtime.test.ts` — 10 个 `node:test` 用例
- `test/golden/seed-42.json` — seed=42 的金标准轨迹（46 事件）
