# keyed-serial-queue

每键（per-key）串行任务队列：同一 key 的任务严格按提交顺序串行执行，不同 key 之间完全并行。仅使用 TypeScript + Node.js 内置模块，零运行时依赖。

## 特性

- **每键串行、跨键并行**：以 key 为单位维护 Promise 链，链内串行、链间互不阻塞。
- **重入安全**：任务回调内对同一 key 再次 `submit`，新任务排到当前任务之后，提交本身不阻塞、不死锁。
- **同步/异步一致**：任务可同步返回值或返回 Promise，`await` 统一处理，顺序语义不变。
- **异常隔离**：任务抛错只拒绝该次 `submit` 返回的 Promise，同 key 后续任务照常执行。
- **优雅关闭**：`close()` 后新提交以 `QueueClosedError` 拒绝；默认排空已排队任务，`close({ cancelPending: true })` 则取消所有未开始任务（以 `TaskCancelledError` 拒绝），进行中的任务仍会完成。

## API

```ts
import { KeyedSerialQueue } from 'keyed-serial-queue';

const q = new KeyedSerialQueue();

const result = await q.submit('user:42', async () => {
  // 对 'user:42' 串行；与其他 key 并行
  return fetchUser(42);
});

await q.close();                        // 排空模式：等待已排队任务执行完
await q.close({ cancelPending: true }); // 取消模式：未开始任务以 TaskCancelledError 拒绝
```

- `submit<T>(key: string, task: () => T | Promise<T>): Promise<T>` — 提交任务，返回该任务结果的 Promise。
- `close(options?: { cancelPending?: boolean }): Promise<void>` — 关闭队列，返回的 Promise 在所有已接受任务结束后兑现。
- `onIdle(): Promise<void>` — 当前所有 key 的链执行完毕时兑现。
- `isClosed: boolean` / `size: number` — 状态查询。
- 错误类型：`QueueClosedError`、`TaskCancelledError`。

## 测试

```sh
npm test   # tsc 编译后运行 node --test
```

### 实际测试结果（2026-10-06，Node v22.22.1，tsc 7.0.2）

```
    ok 1 - 同一 key 严格串行，按提交顺序执行
    ok 2 - 不同 key 并行执行（存在时间重叠）
    ok 3 - 同一 key 内部不存在并发
    ok 4 - 回调内对同 key 再次提交：排到当前任务之后，不死锁
    ok 5 - 同步返回与异步 Promise 混用时顺序一致
    ok 6 - 任务抛错只拒绝自身，不阻塞同 key 后续任务
    ok 7 - close 后拒绝新提交（QueueClosedError）
    ok 8 - close 默认排空：已排队任务全部执行完毕
    ok 9 - close({cancelPending:true})：未开始任务以 TaskCancelledError 拒绝，进行中的完成
    ok 10 - close 返回的 Promise 等待所有 key 的任务结束
    ok 11 - 结果 Promise 按任务各自兑现，值互不错位
# tests 11
# pass 11
# fail 0
```

## 实现说明

每个 key 维护一条 Promise 链（`Map<string, Promise<void>>`）：`submit` 把任务接到链尾，任务的错误被捕获并转给该次提交自己的 Promise，因此链本身永不拒绝、后续任务不受前序异常影响。链尾 settle 后自动清理空链，避免内存泄漏。`close({ cancelPending: true })` 通过给未开始的排队项打取消标记实现，任务出队时检查标记并跳过执行。
