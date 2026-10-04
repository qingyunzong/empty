# scoped-event-bus

TypeScript 事件总线，仅依赖 Node.js 内置模块（运行时 `node:async_hooks`，测试 `node:test` / `node:assert`）。核心语义：**发布时固定订阅快照**，每个在途调用由**显式作用域**管理，异常沿发布树归并。

## 语义

- **快照发布**：每次发布（`publishSync` / `publish`）在进入时固定订阅快照；回调中增删订阅只影响后续发布。当前快照中被移除的订阅仍会执行完本次发布。
- **每次发布至多一次**：一次订阅在一次发布中只执行一次；回调内重入发布会产生发布树的新节点（新快照），不会重复触发当前发布。
- **异常汇总**：回调异常被记录而不阻止同发布的其他回调。异常按**发布树先序**归并：每个调用作用域先记录自身处理器错误，再按创建顺序归并其派发布的子树错误；根发布向调用方抛出 `PublishAggregateError`。派发布的错误总是向根归并——若回调 `await` 派发布且不捕获，同一批错误通过子节点身份去重，不会重复计数。
- **异步发布**：`publish` 顺序等待每个回调；回调可以 `await` 后再重入发布。**父发布会等待其全部派发布完成清理**（包括回调未 `await` 的 fire-and-forget 派发布），`publish` 返回的 promise 才会落定；此时 `bus.inFlightCount === 0`。
- **订阅移除**：`unsubscribe()` 立即生效；`unsubscribe({ wait: true })` 等待该订阅所有在途回调结束。回调移除**自己**（或其在途祖先）时不会自等待——等待集合自动排除当前调用栈上的作用域。若等待会构成循环（两个并发回调互相等待对方），抛出 `CyclicWaitError` 而不是死锁。
- **显式作用域**：每次在途调用对应一个 `InvocationScope`（`enter`/`exit`、父子链、派发布列表、`settled` promise），订阅的在途集合与 `bus.inFlightCount` 均由其维护。
- 同步发布中的异步处理器（返回 thenable）记为汇总错误；从同步发布派生的异步发布视为根发布（同步父发布无法等待异步清理）。

## 与快照解释器核对

`src/interpreter.ts` 是快照语义的可执行规范（纯函数，与总线实现无关）。`src/runner.ts` 把同一份场景 DSL 分别在同步与异步（回调先 `await` 再行动）模式下跑在真实总线上：

- `test/differential.test.ts`：400 个确定性随机种子场景（嵌套发布、同主题重入、动态增删、失败、yield），断言**调用轨迹与归并错误序列**和解释器完全一致，且发布后无泄漏作用域。
- `test/interleavings.test.ts`：枚举嵌套发布 / 取消 / 移除的交错——3 个订阅、动作池 9+9+4、计划长度 ≤2，共 **4550 种交错**，每种在同步与异步模式下各跑一遍并带死锁看门狗；另枚举 16 种 `wait` 移除交错（自移除、互相等待、嵌套发布内移除）。全部终止、轨迹与解释器一致、作用域计数归零。

## 无死锁论证

等待只存在于两处，均有终止保证：

1. **父发布等待派发布**：派发布构成以创建关系为边的树（森林），等待方向总是从父到子；树无环，且每个节点只等待有限个子节点，子节点有限时间内落定，故等待有限。
2. **移除等待在途回调**：等待集合排除了当前作用域及其全部祖先（沿 `AsyncLocalStorage` 调用栈链），因此自移除与祖先移除不会自等待；对其余目标先查等待图（wait-for graph），若 `当前 → 目标` 会成环则抛 `CyclicWaitError`。等待图始终无环 ⇒ 等待边构成 DAG，沿边必达无出边节点（只等待已在运行、终将落定的回调），故所有等待有限。

上述两类等待互不阻塞：发布等待的是 `settled`（作用域退出即解决），移除等待的也是 `settled`；作用域退出不等待任何移除操作，故不存在交叉循环。枚举测试（4550+16 种交错，看门狗 1s）从实证上覆盖该论证。

## 使用

```ts
import { EventBus } from "./src/event-bus";

const bus = new EventBus();
const sub = bus.subscribe<{ id: number }>("user.created", async (payload, ctx) => {
  if (ctx.depth === 0) await bus.publish("audit", payload); // await 后重入
});
await bus.publish("user.created", { id: 1 }); // 等待派发布清理；子树异常汇总为 PublishAggregateError
await sub.unsubscribe({ wait: true });        // 等待在途回调；回调内自移除不会自等待
```

## 测试

`npm test`（编译 + `node --test`，无需安装依赖；TypeScript 编译器为全局 `tsc`）。

实际结果（Node v22.22.1，tsc 7.0.2）：

```
# tests 4   (测试文件：sync / async / differential / interleavings)
# pass 4
# fail 0
```

- `sync.test.js`：6 项通过（快照增删、重入唯一性、树序异常归并、同步发布中的异步处理器、取消）
- `async.test.js`：8 项通过（await 后重入、派发布清理、fire-and-forget 错误归并、移除等待、自移除、祖先移除、循环等待抛错、跨 await 快照）
- `differential.test.js`：400 种子 × (sync+async) 与解释器轨迹/错误一致
- `interleavings.test.js`：4550 交错 × 2 模式 + 16 等待移除交错，全部无死锁且与解释器一致
- 总耗时约 3 秒

## 实现说明

- 上下文传播用**模块级单例** `AsyncLocalStorage`：Node.js 将存活的 ALS 实例保存在全局注册表中，实例数增长会线性拖慢上下文切换（实测每总线一个 ALS 时 5000 次发布从 ~20ms 退化到 ~69s），故所有总线实例共享一个存储；存储的作用域对象自带总线标识，语义安全。
- 派发布 promise 附带 rejection 吸收器：错误总是汇总给 `await` 它的调用方与根发布，fire-and-forget 不会产生未处理拒绝。
