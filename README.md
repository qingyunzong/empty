# keyed-serial

每键串行任务执行器（TypeScript，仅 Node.js 内置库，零运行时依赖）：

- **同键串行、异键并行**：同一 key 的任务严格按提交顺序逐个执行；不同 key 之间完全并行。
- **重入安全**：任务回调内对同键再次 `submit` 时，新任务排到当前任务之后执行，不会死锁。
- **顺序与完成方式无关**：任务同步返回值或返回 Promise，顺序语义一致。
- **异常隔离**：任务抛错只拒绝自己的 Promise，不阻塞同键后续任务。
- **可关闭**：`close()` 后拒绝新提交；默认排空队列，或 `close({ cancelPending: true })` 取消未开始的任务（其 Promise 以 `TaskCancelledError` 拒绝，已开始任务仍执行完）。

## 使用

```ts
import { KeyedSerialExecutor } from "./src/keyed-serial.js";

const executor = new KeyedSerialExecutor();

const a = executor.submit("user:1", async () => {
  // 与所有 "user:1" 任务互斥执行；与 "user:2" 并行
  return fetchAndStore();
});

// 任务内部可对同键继续提交，排在当前任务之后：
executor.submit("user:1", async () => {
  executor.submit("user:1", () => followUp()); // 不死锁
});

await executor.close();                          // 排空：等待所有排队任务完成
// 或 await executor.close({ cancelPending: true }); // 取消未开始的任务
```

## API

- `submit<T>(key: string, task: () => T | Promise<T>): Promise<T>` — 提交任务；关闭后以 `ExecutorClosedError` 拒绝。
- `close(options?: { cancelPending?: boolean }): Promise<void>` — 关闭执行器；`cancelPending` 默认 `false`（排空）。
- `isClosed` / `runningCount` / `pendingCount(key?)` — 状态观察。
- 错误类型：`ExecutorClosedError`、`TaskCancelledError`。

## 测试

```sh
npm test   # tsc 编译到 dist/ 后用 node --test 运行（需全局 tsc，无 npm 依赖）
```

实测结果（Node v22.22.1，tsc 7.0.2，2026-10-06）：

```
# Subtest: KeyedSerialExecutor
    ok 1 - same key runs serially in submission order, mixing sync and async completion
    ok 2 - different keys run in parallel
    ok 3 - re-entrant submit on the same key queues behind the current task instead of deadlocking
    ok 4 - a throwing task rejects its own promise but does not block later tasks
    ok 5 - close() rejects new submissions
    ok 6 - close() drains queued tasks by default
    ok 7 - close({ cancelPending: true }) cancels not-yet-started tasks but lets the running one finish
# tests 7
# pass 7
# fail 0
```

## 结构

- `src/keyed-serial.ts` — 执行器实现（每键 FIFO 队列 + 单任务泵循环）。
- `test/keyed-serial.test.ts` — 基于 `node:test` / `node:assert` 的行为测试。
- `types/node-shim.d.ts` — 环境无 `@types/node` 时的最小类型声明。
