# arm-track-simulator

多机械手搬物模拟器。纯 TypeScript + Node.js 内置库（`node:test` / `node:assert` /
`node:fs` / `node:os` / `node:path`），零第三方依赖。

## 功能

- **共享轨道区间互斥**：每个区段（segment）是一把互斥锁，同一时刻至多一个机械手持有，
  竞争者进入等待队列（`src/simulator.ts`）。
- **获取/释放动作**：机械手作业由 `acquire` / `release` / `move` / `fail` 命令序列构成；
  `move` 要求持有目标区段、物品在源区段、目标区段空闲。
- **失败逆序回滚**：任一动作失败（含注入的 `fail`），只释放该机械手自己已获取的资源，
  严格按获取的逆序（LIFO）释放，并唤醒等待者。
- **循环等待检测**：由阻塞关系构建 wait-for 图，DFS 找环；输出文本邻接表与 Graphviz
  DOT 图（环边标红），见 `src/waitgraph.ts`。
- **任意事件快照**：全部状态变更记入事件日志；`snapshotAtEvent(seq)` 通过重放日志
  重建任一事件后的状态，`saveSnapshot` / `loadSnapshot` 落盘为 JSON
  （`src/snapshot.ts`）。
- **重放校验**：`replayEvents` 从初始配置逐事件重放，每个事件后校验不变量：
  物品位置唯一（物品↔区段双射）、物品守恒（不丢不多）、互斥（锁持有者唯一且与
  手臂 held 列表一致）、等待边合法。

## 使用

```sh
npm test        # tsc 编译 + node --test
npm run build   # 仅编译到 dist/
```

```ts
import { Simulator } from "./src/index";

const sim = new Simulator({
  segments: ["S1", "S2"],
  items: { box1: "S1", box2: "S2" },
  arms: [
    { id: "A", program: [
      { kind: "acquire", segment: "S1" },
      { kind: "acquire", segment: "S2" },
      { kind: "move", item: "box1", from: "S1", to: "S2" },
    ]},
    { id: "B", program: [
      { kind: "acquire", segment: "S2" },
      { kind: "acquire", segment: "S1" },
      { kind: "move", item: "box2", from: "S2", to: "S1" },
    ]},
  ],
});
sim.run();
console.log(sim.waitGraphText());
```

死锁场景实际输出：

```
wait-for graph:
  A -> B
  B -> A
circular wait detected: A -> B -> A

digraph wait_for {
  rankdir=LR;
  "A";
  "B";
  "A" -> "B" [color=red,penwidth=2];
  "B" -> "A" [color=red,penwidth=2];
}
```

## 测试结果（实际运行记录）

环境：Node.js v22.22.1，TypeScript 7.0.2（本机 Node 未编译类型剥离支持，
故 `npm test` 先 `tsc` 编译到 `dist/` 再用 `node --test` 运行）。

`npm test` 输出摘要：

```
# Subtest: dist/tests/deadlock.test.js
ok 1 - dist/tests/deadlock.test.js
# Subtest: dist/tests/simulator.test.js
ok 2 - dist/tests/simulator.test.js
# Subtest: dist/tests/snapshot.test.js
ok 3 - dist/tests/snapshot.test.js
# tests 3
# pass 3
# fail 0
```

逐用例（9 个全部通过）：

```
ok 1 - circular wait is detected and reported as a graph
ok 2 - three-arm cycle is found; acyclic waits report no cycle
ok 1 - two arms hand an item over shared segments; replay is clean
ok 2 - shared segment is mutually exclusive
ok 3 - failure releases only acquired resources, in reverse order
ok 4 - illegal move fails the arm and rolls back its held segments
ok 1 - snapshot of any event can be saved, reloaded and verified
ok 2 - verifier flags duplicated and lost items
ok 3 - verifier flags broken mutual exclusion in a snapshot
```

## 目录

- `src/model.ts` — 命令、事件、配置类型
- `src/simulator.ts` — 确定性分轮调度引擎：互斥、回滚、死锁检测
- `src/waitgraph.ts` — wait-for 图、找环、文本/DOT 输出
- `src/snapshot.ts` — 快照存取、事件重放、不变量校验
- `tests/` — `node:test` 测试（模拟器、死锁、快照三组）
- `types/node.d.ts` — 所用 Node 内置模块的最小类型声明（无 @types 依赖）
