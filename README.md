# crdt-text-replica

RGA 风格的文本复制库（CRDT），TypeScript 编写，仅使用 Node.js 内置库，零运行时依赖。

## 特性

- **唯一 ID**：每个字符 ID 为 `<replicaId>:<counter>`，全局唯一、可比较。
- **前驱链接**：每次插入引用前驱字符 ID（文档头部为哨兵 `ROOT`）。
- **并发同位置插入按 ID 排序**：同一前驱下的子节点按 ID 降序排列（ID 大者靠前），所有副本结果一致。
- **删除留墓碑**：删除只打 `tombstone` 标记，节点永不从树中移除，保证后续乱序消息仍可挂载。
- **前驱未到先缓冲，绝不改挂根**：前驱/删除目标未到达时，操作进入待决缓冲区；
  依赖到达后按序级联冲刷（`flush`），缺失期间文本中不可见，也不会错误地挂到根部。
- **乱序/重复消息幂等**：重复插入/重复删除均为无操作。
- **恶意依赖环检测**：自环（`predId === id`）立即拒绝；缓冲区中的互相依赖环
  （如 `A.pred=B, B.pred=A`，任意长度）通过 `detectCycles()` 三色 DFS 检出并隔离，
  挂在环上的诚实节点保持缓冲、不被误判。
- **全事件构树投影对照**：`buildFromEventLog(events)` 将完整事件日志按 ID 排序后
  多趟扫描至不动点，重建参考投影；与增量副本的 `text()` 逐一比对验证收敛性。

## 使用

```ts
import { Replica, ROOT, buildFromEventLog } from "crdt-text-replica";

const a = new Replica("A");
const op1 = a.localInsert("h", ROOT);
const op2 = a.localInsert("i", op1.id);

const b = new Replica("B");
b.apply(op2); // 前驱未到：缓冲，text() === ""
b.apply(op1); // 依赖到达：级联冲刷，text() === "hi"

b.apply(a.localDelete(op1.id)); // 删除留墓碑
b.text();  // "i"
b.size();  // 2（墓碑仍在树中）
```

## 测试

```sh
npm test   # tsc 编译 + node --test
```

## 实际测试结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

```
ok 1 - basic insert produces visible text
ok 2 - delete leaves a tombstone (node stays, text shrinks)
ok 3 - concurrent inserts at same position are ordered by id (greater id first)
ok 4 - out-of-order delivery: child buffered until predecessor arrives, never re-attached to root
ok 5 - delete arriving before its target insert is buffered
ok 6 - duplicate messages are idempotent
ok 7 - self-dependency is rejected immediately
ok 8 - malicious dependency cycle is detected and quarantined
ok 9 - cycle of three is detected
ok 10 - chain into a cycle stays buffered but is not itself cyclic
ok 11 - convergence: shuffled + duplicated delivery matches full-event-log projection
ok 12 - event log with a malicious cycle: reference projection excludes it too
# tests 12
# pass 12
# fail 0
```

测试 11 为随机化收敛测试（确定性种子）：3 个副本产生 60 步并发插入/删除，
事件乱序并随机重复投递到 5 个副本，最终全部收敛且与全事件日志重建的参考投影一致。

## 文件结构

- `src/crdt.ts` — 核心实现（`Replica`、`buildFromEventLog`、`compareIds`）
- `test/crdt.test.ts` — `node:test` 测试套件
- `types/node-shims.d.ts` — 离线环境下 `node:test` / `node:assert` 的最小类型声明
