# versioned-subscription-hub

带版本快照的订阅库。TypeScript 编写，运行时仅依赖 Node.js 内置模块（零 npm 依赖）。

## 交付保证

每个订阅各自独立满足：

1. **快照先行**：首个投递一定是 `snapshot`，携带版本 `V` 与状态。
2. **期间增量连续**：快照 Promise 未决期间到达的增量被缓冲，快照之后按
   `V+1, V+2, ...` 连续投递，不插队、不缺口。
3. **溢出显式重同步**：订阅缓冲区（`bufferSize`）满时，丢弃积压并发送显式
   `resync`（更新版本的全新快照），绝不静默跳版本。
4. **关闭不可复活**：`close()` 是终态。快照 Promise 在关闭后完成（或
   `hub.close()` 与快照交错）时结果被丢弃，订阅不会被复活。

## 关键机制

- 订阅时**同步**捕获 `baseVersion` 与不可变状态引用，再异步执行快照函数；
  期间 `publish` 的增量进入订阅队列，快照就绪后 unshift 到队首统一泵出。
- 每次挂载周期（首次快照 / 重同步）递增 `generation`；快照 Promise 完成时
  校验 `closed` 与 `generation`，过期结果直接丢弃——这是关闭交错不复活的核心。
- 每个订阅一条串行泵（`pump`）：handler 可返回 Promise，慢客户端自然产生
  背压；handler 内可重入调用 `publish` / `close`，增量仅追加到队列，由当前
  泵循环按序消费。

## API

```ts
const hub = new VersionedHub<string[], string>({
  initialState: [],
  apply: (state, data) => [...state, data],   // 纯函数归约器
  snapshot: async (state) => serialize(state), // 可选，异步快照
});

const sub = hub.subscribe(
  async (delivery) => { /* snapshot | increment | resync | closed */ },
  { bufferSize: 16 }, // 可选，溢出即显式 resync
);

hub.publish('increment-data'); // => 新版本号
sub.close();
hub.close();
```

## 测试

```sh
npm test   # tsc 编译（dev 依赖全局 tsc）后运行 node:test 验收测试
```

验收覆盖：快照先行与期间增量连续、缓冲溢出显式重同步、关闭与快照
Promise 交错不复活（含 `hub.close()` 变体）、handler 重入 `publish`/`close`、
慢客户端背压重同步且同 hub 快客户端不受影响。

## 实际测试结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

```
TAP version 13
ok 1 - snapshot is delivered first; increments published during the snapshot are buffered and contiguous
ok 2 - buffer overflow triggers an explicit resync instead of skipping versions
ok 3 - close() interleaved with a pending snapshot Promise does not resurrect the subscription
ok 4 - hub.close() while a snapshot Promise is pending prevents any delivery
ok 5 - reentrant publish from inside a handler stays ordered and contiguous
ok 6 - reentrant close from inside a handler stops further deliveries
ok 7 - slow client resyncs while a fast client on the same hub is unaffected
ok 8 - publish after hub.close() throws and closed subscriptions stay silent
1..8
# tests 8
# pass 8
# fail 0
# duration_ms 37.887151
```
