# session-diff

会话统计库（TypeScript + Node.js 内置库，零运行时依赖）。

## 规则

- 同一用户的事件按 `(ts, id)` 排序后，相邻事件间距 `<= gapMs` 归一为同一会话，超过则分裂。
- 会话 ID 取成员事件的最小 ID。
- 支持乱序增删；`apply` 返回一个批次的**净差分**（批内瞬态变化相互抵消）。
- 删除中间事件可能使会话分裂；更正时间（同 ID 重新插入，即 upsert）可能使会话合并。
- `rebuild()` 从原始事件集合独立地排序重建，用于与增量维护的状态交叉核对。

## API

```ts
import { SessionStore } from "./src/sessionizer";

const store = new SessionStore(30_000); // gapMs

// 乱序批量增删，返回净差分 { added, removed }
const diff = store.apply([
  { type: "insert", event: { id: 3, userId: "u1", ts: 20_000 } },
  { type: "insert", event: { id: 1, userId: "u1", ts: 0 } },
  { type: "delete", id: 2 },
]);

store.sessions(); // 增量维护的当前会话
store.rebuild();  // 独立排序重建（用于核对）
```

差分语义：`removed` 为批前存在、批后不存在的会话；`added` 反之。
会话按完整内容（ID、起止时间、成员列表）比较，内容不变则不出现在差分中。

## 测试

```sh
npm test   # = tsc 编译 + node --test
```

测试覆盖：gap 边界（含等于 gap 归一）、最小 ID 规则、乱序插入等价性、
中间插入合并、中间删除分裂、时间更正合并、空操作、净差分抵消，
以及 500 轮随机乱序批次的模糊测试——每轮同时校验：

1. 净差分一致性：`before - removed + added == after`；
2. 增量状态与独立排序重建 `rebuild()` 完全一致；
3. 会话 ID 恒等于成员最小 ID。

## 实际测试结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

`npm test` 输出（摘要）：

```
# Subtest: dist/test/sessionizer.test.js
ok 1 - dist/test/sessionizer.test.js
# tests 1
# pass 1
# fail 0
# duration_ms 963.950115
```

逐条明细（`node dist/test/sessionizer.test.js`，退出码 0）：

```
ok 1 - groups events with adjacent gap <= gapMs; boundary is inclusive
ok 2 - session ID is the minimum member event ID
ok 3 - out-of-order inserts match in-order result
ok 4 - inserting a middle event merges two sessions into one
ok 5 - deleting a middle event splits one session into two
ok 6 - correcting an event time (upsert) can merge sessions
ok 7 - deleting a nonexistent event is a no-op with an empty diff
ok 8 - net diff cancels transient changes within one batch
ok 9 - deleting all events of a user removes every session
ok 10 - fuzz: random out-of-order batches; net diff and rebuild always agree
# tests 10
# pass 10
# fail 0
```

## 备注

- 沙箱无网络，无法安装 `@types/node`；`types/node-shims.d.ts` 提供了
  `node:test` / `node:assert/strict` 的最小 ambient 声明。
- 本环境 Node 的 `--test` 汇总按文件聚合计数；逐条明细可直接运行编译后的测试文件查看。
