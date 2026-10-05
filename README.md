# browser-lock-sim

纯内存的浏览器锁模拟库（TypeScript + Node.js 内置库，零运行时依赖）。

## 语义

- **乱序消息 + 整数逻辑时钟**：事件可乱序提交，`run()` 按 `clock` 升序应用（同时钟保持输入顺序）。
- **按序授予**：每把锁维护 FIFO 等待队列，锁空闲时授予队首；队首若已崩溃或属于旧代则丢弃并顺延。
- **页面崩溃**：`crash` 释放该页面持有的所有锁，并从所有等待队列中移除其请求。
- **代（generation）防护**：`recover` 为同一页面 ID 开启新代；携带旧代号的 `request`/`release`（如崩溃前发出的延迟释放消息）一律拒绝，不影响当前持有者。
- **互斥核对**：每应用一个事件后记录所有权快照（`StepRecord.owners` / `queues`），`verifyMutualExclusion()` 复核全程每把锁至多一个持有者且持有者不同时处于等待队列。

## 事件

```ts
{ clock: number,                     // 整数逻辑时钟
  type: "request" | "release" | "crash" | "recover",
  pageId: string,
  lock?: string,                     // request/release 必填
  generation?: number }              // request/release 必填
```

## 使用

```bash
npm test    # tsc 编译到 dist/ 后用 node --test 运行
npm run demo  # 打印乱序场景的每步所有权追踪
```

要求：Node.js（内置 `node:test` / `node:assert`）与 `tsc`（TypeScript 编译器）。

## 实际测试结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

`npm test` 输出：

```
> tsc -p tsconfig.json && node --test dist/test/lock-sim.test.js

TAP version 13
# Subtest: dist/test/lock-sim.test.js
ok 1 - dist/test/lock-sim.test.js
# tests 1
# pass 1
# fail 0
```

逐条子测试（`node dist/test/lock-sim.test.js`）：6/6 通过

```
ok 1 - FIFO: requests are granted in order
ok 2 - out-of-order input is applied in logical-clock order
ok 3 - crash releases held locks and drops waiting requests
ok 4 - recover creates a new generation; stale release is rejected
ok 5 - stale request from an old generation is rejected
ok 6 - mutual exclusion holds across a mixed out-of-order scenario
```

`npm run demo` 每步所有权追踪（输入为乱序事件，clock 1–10）：

```
#0 clock=1 request(A,L1,gen1) -> OK: queued A#1 on L1 | owners: L1=A#1
#1 clock=2 request(B,L1,gen1) -> OK: queued B#1 on L1 | owners: L1=A#1 | waiting: L1:[B#1]
#2 clock=3 request(A,L2,gen1) -> OK: queued A#1 on L2 | owners: L1=A#1 L2=A#1 | waiting: L1:[B#1]
#3 clock=4 request(C,L1,gen1) -> OK: queued C#1 on L1 | owners: L1=A#1 L2=A#1 | waiting: L1:[B#1,C#1]
#4 clock=5 release(A,L1,gen1) -> OK: released L1 by A#1 | owners: L1=B#1 L2=A#1 | waiting: L1:[C#1]
#5 clock=6 crash(A) -> OK: crash A#1: freed L2 | owners: L1=B#1 L2=- | waiting: L1:[C#1]
#6 clock=7 recover(A) -> OK: recover A: new generation 2 | owners: L1=B#1 L2=- | waiting: L1:[C#1]
#7 clock=8 request(A,L1,gen2) -> OK: queued A#2 on L1 | owners: L1=B#1 L2=- | waiting: L1:[C#1,A#2]
#8 clock=9 release(B,L1,gen1) -> OK: released L1 by B#1 | owners: L1=C#1 L2=- | waiting: L1:[A#2]
#9 clock=10 release(A,L1,gen1) -> REJECTED: stale release from A#1 (current generation 2) | owners: L1=C#1 L2=- | waiting: L1:[A#2]

mutual exclusion verified: true
```
