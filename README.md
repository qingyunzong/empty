# bounded-pubsub

有界消息队列订阅库：每个订阅是一个以异步迭代器（`AsyncIterableIterator`）暴露的有界 FIFO 队列。
仅使用 TypeScript + Node.js 内置库（`node:test`、`node:assert`），零运行时依赖。

## 语义

- `createTopic<T>({ capacity })` 创建主题（默认每订阅容量 16）。
- `topic.subscribe({ capacity })` 返回 `Subscription<T>`，即可异步迭代的有界队列。
- `await topic.publish(value, { signal })` 对调用时刻的订阅者快照逐一遍历：
  - 消息进入所有订阅者缓冲后才会 resolve；
  - 任一慢订阅者队列满额时，发布阻塞在该订阅者的 FIFO 等待队列上；
  - 传入 `AbortSignal` 可取消阻塞中的发布：等待者被移除，**预留的槽位被释放**，后续发布者得以继续；发布 Promise 以 `AbortError` reject。
- `iterator.return()`（或 `for await` 中 `break`）**仅关闭该订阅**：
  - 该订阅上阻塞的发布者被同步释放（消息仅对该订阅丢弃）；
  - 挂起的 `next()` 以 `done: true` 终结，残留缓冲被丢弃；
  - 其他订阅者不受影响——发布与退出竞争时，他人消息不丢失（快照语义）。
- `topic.close()` 优雅关闭所有订阅：不再接受新消息，已缓冲消息仍可被消费完。

## 使用

```ts
import { createTopic } from './src/pubsub.js';

const topic = createTopic<string>({ capacity: 4 });
const sub = topic.subscribe();

await topic.publish('hello');
for await (const msg of sub) {
  console.log(msg);
  break; // 触发 return()，仅关闭本订阅
}
```

## 测试

```
npm test
```

`npm test` 先用 `tsc` 编译到 `dist/`，再以 `node --test` 运行 `dist/tests/*.test.js`。
测试使用可控 Promise（`deferred`）与 `stateOf()` 探针确定性地区分 pending/fulfilled/rejected，
核对每个订阅者的交付次数与事件终结顺序。

### 实际结果（Node v22.22.1，2026-10-05）

```
✔ async iterator delivers messages in FIFO order and return() ends iteration (12.804933ms)
✔ return() closes only that subscription (delivery counts) (1.386046ms)
✔ full slow subscriber blocks publish; consuming unblocks it (termination order) (14.95486ms)
✔ cancelling a blocked publisher releases its reserved slot (4.139709ms)
✔ aborting before publish rejects immediately without enqueuing (0.968252ms)
✔ publish racing a subscriber exit does not lose other subscribers messages (1.485201ms)
✔ close order: return() releases the blocked publisher before iteration ends (3.23847ms)
✔ multiple blocked publishers are promoted in FIFO order (5.698897ms)
✔ for-await loop exits cleanly on return() with exact delivery count (2.01784ms)
ℹ tests 9
ℹ pass 9
ℹ fail 0
```

连续运行 5 次全部通过。

## 文件

- `src/pubsub.ts` — 库实现（`Topic` / `Subscription` / `createTopic`）
- `tests/pubsub.test.ts` — 9 个测试（`node:test`）
- `types/node-shims.d.ts` — 环境无 `@types/node` 时的最小类型声明
