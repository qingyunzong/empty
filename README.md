# scoped-event-bus

一个 TypeScript 事件总线库，仅依赖 Node.js 内置模块（`node:async_hooks`），
核心语义：**发布即快照**、**显式作用域跟踪在途调用**、**发布树异常归并**。

## 语义

### 快照发布

- `publish` / `publishAsync` 在发布开始时对当前订阅拍快照，回调中增删订阅
  只影响后续发布，不影响本次分派（`test/snapshot.test.ts`）。
- 一次发布中，一个订阅即使遇到重入发布也只执行一次；重入（嵌套）发布是
  发布树上的新节点，拥有自己的快照。
- 分派顺序 = 订阅顺序；异步发布顺序串行执行快照回调。

### 显式作用域与发布树

- 每个在途回调调用都包在一个 `InvocationScope` 中，通过
  `AsyncLocalStorage` 跨 `await` 传播（`src/event-bus.ts`）。
- 每次发布是一个 `PublishNode`；回调内（包括 `await` 之后）发起的派生发布
  挂到当前作用域所属节点下，形成发布树。
- **父发布等待派生发布清理**：`publishAsync` 返回的 promise 只有在所有
  回调以及所有派生发布（含 fire-and-forget、`await` 后再重入的）彻底
  完成后才 settle。

### 异常归并

- 回调异常不阻止其他回调；每个发布节点按时间序记录「自身回调错误」与
  「派生发布」日志，finalize 时按**发布树顺序**（时间序深度优先）归并，
  以 `AggregateError` 抛出/拒绝。
- 回调 `await` 派生发布并重抛其聚合错误时，按身份去重，不重复计数；
  即使回调捕获了派生错误，归并仍然无损（错误已记录在派生节点的日志位置）。
- 同步发布无法等待异步派生发布：其错误成为 `lateErrors`
  （`onLateError` 回调 / `drainLateErrors()`）。同步发布中返回 thenable
  的回调被记为发布错误（提示改用 `publishAsync`），不会成为未处理拒绝。

### 移除与取消

- `sub.remove()`：立即摘除，在途回调继续运行。
- `sub.removeAndWait()`：摘除并等待该订阅**所有**在途回调完成；但绝不等待
  当前执行所依赖的作用域——当前作用域及其沿发布树的全部祖先作用域都被
  排除，因此回调内移除自己（直接或经嵌套发布）不会自等待、不会死锁。
- `publishAsync(topic, payload, { signal })`：中止信号跳过尚未开始的快照
  回调；在途回调运行至完成；派生发布仍被等待清理；receipt 标记
  `cancelled: true`。

### 关于 fire-and-forget 派生发布的顺序说明

被 `await` 的派生发布严格按深度优先前序执行（与同步解释器一致）。
未 `await` 的派生发布与父发布分派循环按微任务 FIFO 交错：顺序确定，
但不是严格的深度优先——父发布仍保证在自身 settle 前等待其全部清理完成。

## 无死锁论证

库内部的等待只有三类，均不构成循环等待：

1. **父发布等子发布**（`node.settled`）：等待方向严格沿发布树从父到子，
   子节点从不等待父节点，偏序无环。
2. **`removeAndWait` 等在途作用域**：排除当前作用域及其全部祖先作用域
   （沿 `createdBy` 链），因此等待集合里不存在任何"正在等待本次调用"
   的作用域；每个作用域的 `done` 必在 `finally` 中 resolve。
3. **取消不等待**：取消只是置标志位，分派循环在下一回调前检查退出。

`test/interleavings.test.ts` 对 嵌套深度(1..3) × 派生发布 await/不await ×
取消(无/根/子) × 移除(无/自己/旁观者/祖先) 共 **72 种交错**逐一运行，
每种都有看门狗超时断言 settle，并断言取消与链式完成的轨迹不变量，
且全程无未处理拒绝——以枚举方式验证上述论证。

## 快照解释器核对

`test/helpers/interpreter.ts` 是独立的朴素参考实现（纯递归、无
AsyncLocalStorage、无作用域机制），即可执行规范。
`test/helpers/script.ts` 用种子化 PRNG 生成随机操作脚本（订阅/退订/
重入发布/抛错，层级有向无环保证递归有界，订阅数上限保证扇出有界），
在解释器、同步总线、异步总线上分别执行并逐种子比对**调用轨迹**与
**每次发布的聚合错误序列**（`test/differential.test.ts`，300 个种子）。

## API

```ts
const bus = new EventBus();
const sub = bus.subscribe('topic', async (payload, ctx) => { ... });
bus.publish('topic', data);                       // 同步，出错抛 AggregateError
await bus.publishAsync('topic', data, { signal });// 异步，返回 PublishReceipt
sub.remove();                                       // 立即摘除
await sub.removeAndWait();                        // 摘除并等待在途回调
```

## 测试

```sh
npm test    # tsc -p tsconfig.json && node --test "dist/test/*.test.js"
```

### 实际结果（Node v22.22.1, tsc 7.0.2）

```
ok 1 - dist/test/async-publish.test.js     ( 8 个测试：await后重入/父等派生/顺序/取消 )
ok 2 - dist/test/differential.test.js      ( 2 个测试：同步+异步 × 300 种子对照解释器 )
ok 3 - dist/test/errors.test.js            ( 7 个测试：聚合/树序归并/去重/晚到错误 )
ok 4 - dist/test/interleavings.test.js     ( 2 个测试：72 种交错枚举无死锁+无未处理拒绝 )
ok 5 - dist/test/removal.test.js           ( 6 个测试：在途等待/自移除/祖先移除 )
ok 6 - dist/test/snapshot.test.js          ( 5 个测试：快照/重入仅一次/顺序 )
# tests 6
# pass 6
# fail 0
```

共 30 个断言测试，全部通过（单次 `npm test` 约 1.2s）。
