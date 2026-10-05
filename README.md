# session-stats 会话统计库

同用户相邻事件间距不超过 `gap` 归一为同一会话；删除中间事件可能使会话分裂，
更正事件时间可能使会话合并；会话 ID 取成员事件的最小 ID。
乱序增删改后输出**净差分**（相对上一次 `commit()` 基线），并可随时用
**排序重建**参考实现核对增量维护结果。

仅使用 TypeScript + Node.js 内置模块（`node:test` / `node:assert`），无运行时依赖。

## 使用

```ts
import { SessionStore } from "./src/session-store.js";

const store = new SessionStore(30_000); // gap = 30s

store.apply([                        // 乱序增删改
  { type: "add", event: { id: "e2", userId: "u1", timestamp: 10_000 } },
  { type: "add", event: { id: "e1", userId: "u1", timestamp: 0 } },
  { type: "add", event: { id: "e3", userId: "u1", timestamp: 45_000 } },
]);
store.commit();                      // 设定差分基线

store.removeEvent("e2");             // 删除桥接事件 -> 分裂为两个会话
store.updateEventTime("e3", 20_000); // 更正时间 -> 重新合并

const diff = store.diff();           // 净差分 { added, removed, changed }
store.verify();                      // 与排序重建核对，不一致则抛错
```

## 设计

- **增量维护**：每用户一条按 `(timestamp, id)` 排序的事件序列 + 会话对象集合；
  插入时按左右邻居的间距决定 新建/并入/桥接合并，删除时沿间隔重新分段（至多分裂为两段），
  更正时间 = 删除 + 重新插入。
- **会话 ID**：物化会话时取成员事件的最小 ID；最小 ID 变化在差分中体现为 删 + 增。
- **净差分**：`diff()` 对比当前快照与 `commit()` 基线，先增后删的会话不出现在结果中。
- **核对**：`rebuild()` / `SessionStore.rebuildSessions()` 从原始事件全量排序重建，
  `verify()` 断言增量结果与之一致；随机测试同时用独立事件集合做参考核对。

## 测试

```sh
npm test   # = tsc -p tsconfig.json && node dist/test/session-store.test.js
```

环境：Node.js v22.22.1，TypeScript 7.0.2。实际运行结果（2026-10-05）：

```
ok 1 - session 归一（相邻间距 <= gap）
ok 2 - 删除中间事件导致分裂
ok 3 - 更正时间导致合并
ok 4 - 乱序增删后的净差分
ok 5 - 随机乱序操作与排序重建核对
ok 6 - 边界与错误处理
# tests 17
# suites 6
# pass 17
# fail 0
```

17 个用例全部通过，其中包括 5 个随机种子 × 400 步乱序增删改的
增量 vs 排序重建逐步核对，以及 30 轮差分 vs 双端重建差核对。
