# browser-lock-sim

纯内存事件驱动的浏览器锁模拟库（TypeScript + Node.js 内置模块，零 npm 依赖）。

## 语义

- **按序授予**：每个资源的锁请求按整数逻辑时钟排序后严格 FIFO 授予。
- **乱序输入**：消息可以任意顺序送达，`LockSimulator` 缓冲后按逻辑时钟
  （时钟相同按到达顺序）重放；非整数时钟直接拒绝。
- **页面崩溃**：`crash` 释放该页面持有的所有锁、丢弃其全部等待中的请求，
  被释放的资源按 FIFO 授予下一个等待者。
- **代际恢复**：同一页面 ID `recover` 后代际号 +1；旧代际发来的
  `request`/`release` 消息一律以 `rejected-stale` 拒绝，不影响当前持有者。
- **每步审计**：每条消息应用后记录 `StepRecord`（结果、所有权快照、等待
  队列快照），并校验互斥不变量（每资源至多一个持有者、持有者不在等待
  队列、等待者无重复、持有/等待双向簿记一致、死亡页面不持有不等待）。

## 结构

- `src/lock-manager.ts` — 锁管理器：FIFO 队列、崩溃释放、代际校验、不变量检查
- `src/simulator.ts` — 乱序消息端点（逻辑时钟重排）、场景运行、逐步日志渲染
- `test/lock-manager.test.ts` — `node:test` + `node:assert` 测试
- `src/node-shims.d.ts` — 零依赖下 `node:test`/`node:assert` 的最小类型声明

## 运行

```sh
npm test   # tsc 编译到 dist/ 后用 node --test 运行
```

## 实际测试结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

`npm test` 输出：**7 个测试全部通过**（pass 7 / fail 0，约 70ms）。

其中「崩溃-恢复-旧代际释放」场景的逐步所有权日志（测试内打印的实际输出）：

```
step  1 | clock  1 | request P1#1 A -> granted | owners: A=P1 | mutex:OK
step  2 | clock  2 | request P2#1 A -> queued | owners: A=P1 | waiting: A:[P2#1] | mutex:OK
step  3 | clock  3 | crash   P1 -> crashed (released held: A) | owners: A=P2 | mutex:OK
step  4 | clock  4 | recover P1 -> recovered (new generation 2) | owners: A=P2 | mutex:OK
step  5 | clock  5 | release P1#1 A -> rejected-stale (release from generation 1, current is 2) | owners: A=P2 | mutex:OK
step  6 | clock  6 | request P1#2 A -> queued | owners: A=P2 | waiting: A:[P1#2] | mutex:OK
step  7 | clock  7 | release P2#1 A -> released (granted to next waiter P1) | owners: A=P1 | mutex:OK
```

覆盖的测试：

1. FIFO：乱序送达按逻辑时钟排序授予
2. 崩溃释放持有锁并丢弃等待请求，等待者按序补上
3. 同 ID 恢复生成新代际，旧代际 release 被拒绝
4. 崩溃前的旧代际 request 在恢复后被拒绝
5. 非持有者的 release 被拒绝且不干扰当前所有者
6. 非整数逻辑时钟被拒绝
7. 50 个随机种子的乱序消息流下互斥不变量逐步成立
