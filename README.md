# bounded-pubsub

把有界消息队列暴露为异步迭代器的进程内发布/订阅库。仅使用 TypeScript 与
Node.js 内置库（`node:test`、`node:assert`），零运行时依赖。

## 运行测试

```sh
npm test   # = tsc -p tsconfig.json && node --test "dist/test/**/*.test.js"
```

需要环境中存在 `tsc`（TypeScript 编译器）。构建产物输出到 `dist/`。

## API

```ts
import { Topic, deferred } from "bounded-pubsub";

const topic = new Topic<string>();
const sub = topic.subscribe({ capacity: 1 }); // 有界队列，默认容量 16

// 消费：异步迭代器
for await (const msg of sub) { /* ... */ }

// 发布：慢订阅满额时阻塞，直到有空间或被取消
const delivered: number = await topic.publish("hello");
await topic.publish("hello", { signal: abortController.signal });

await sub.return(); // 仅关闭该订阅
topic.close();      // 优雅关闭整个主题（缓冲消息仍可排空）
```

- `Topic.subscribe({ capacity })` → `Subscription<T>`，实现
  `AsyncIterableIterator<T>`；`capacity` 为缓冲上限（已提交 + 已预留）。
- `Topic.publish(value, { signal })` → `Promise<number>`，返回实际投递的
  订阅数；任一订阅满额时等待，支持 `AbortSignal` 取消。
- `Subscription.return()` 仅关闭该订阅：丢弃缓冲、挂起的 `next()` 立即
  `done`、进行中的发布跳过它，其他订阅不受影响。
- `Subscription.end()`（`Topic.close()` 使用）停止接收新消息，但已缓冲的
  消息可继续排空后再 `done`。
- `Deferred` / `deferred()`：可控 Promise，外部通过 `resolve`/`reject`
  驱动结算，`settled` 可观察；测试用它核对交付次数与终结顺序。

## 设计要点

- **两阶段预留/提交**：`publish` 先在每个订阅的有界队列中预留槽位
  （phase 1），全部成功后统一提交（phase 2）。取消或失败时释放全部已
  预留槽位，不会投出半截消息。
- **发布串行化**：每个主题一把 FIFO 互斥锁，保证所有订阅者看到相同的
  FIFO 顺序，并避免多发布者交叉持槽造成的死锁。
- **发布与退出竞争**：订阅在发布中途 `return()` 时，其在等待的槽位按
  “已关闭”处理（发布者跳过该订阅），其余订阅者照常收到消息，不丢。
- **背压与取消**：槽位等待者按 FIFO 排队；`AbortSignal` 触发时等待者被
  移除并以 `signal.reason` 拒绝，已持有的预留全部释放，槽位可立即被
  后续发布复用。

## 实际测试结果

在本机（Node.js v22.22.1，tsc 7.0.2）执行 `npm test` 的实际输出：

```
ok 1 - deferred: controllable promise settles once, observably
ok 2 - publish delivers to every subscriber in FIFO order
ok 3 - return() closes only that subscription
ok 4 - a full slow subscriber blocks publish until it consumes
ok 5 - aborting a blocked publish releases its reservations
ok 6 - publish racing return() does not lose other subscribers' messages
ok 7 - controllable promise gates consumption; delivery counts and termination order
ok 8 - topic.close() ends consumers gracefully; publish/subscribe after close fail
ok 9 - exact delivery counts across many messages and mixed capacities
ok 10 - concurrent publishes are serialized; each subscriber sees FIFO order
ok 11 - a queued publisher can be aborted while another publish is blocked
# tests 11
# pass 11
# fail 0
```

连续运行 5 次 `npm test` 均全部通过。

注：本环境的 Node 构建对 `node --test <目录>` 支持有异常（把目录当模块
加载），故测试脚本使用 glob 模式 `dist/test/**/*.test.js`。
