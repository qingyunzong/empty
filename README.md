# doc-archive-crdt

支持删除与恢复的文档档案库（state-based CRDT）。TypeScript 编写，仅使用 Node.js
内置库（`node:test` / `node:assert`），零运行时依赖。

## 语义

- **事件溯源**：所有变更（`update` / `delete` / `restore`）是带唯一 id 与因果上下文
  （`deps`）的不可变事件；副本状态是事件集合的纯函数，与到达顺序无关。
- **删除即墓碑**：每次 `delete` 产生一个独立的删除版本（墓碑），可被事件 id 寻址。
- **恢复必须引用具体删除版本**：`restore(doc, deleteId)` 只抵消所引用的那个墓碑；
  引用不存在或其他删除版本均无效。并发删除是独立版本，需各自恢复。
- **未观察删除的旧更新不恢复文档**：`update` 只影响内容，从不改变存活状态；
  与删除并发的旧更新到达后，文档保持已删除。
- **并发恢复保留分支**：内容以 update 事件构成因果 DAG，并发更新（例如两个副本
  各自恢复同一删除版本后分别编辑）各自成为分支头，合并后全部保留。
- **合并幂等**：合并即按事件 id 求并集，幂等、交换、结合；重复投递/自合并均为无操作。
- **内容来源**：每个分支头记录其来源 update 事件 id（`branches[].updateId`），
  可核对内容出处。

## 结构

- `src/events.ts` — 事件类型定义
- `src/archive.ts` — `Archive`：事件集合、墓碑判定、分支头、确定性快照
- `src/client.ts` — `Client`：绑定副本的事件工厂（自动携带因果 deps）
- `test/archive.test.ts` — 单元测试 + 短事件全排列（6 事件，720 种重排）收敛测试，
  逐一核对墓碑集合与内容来源
- `types/node-shim.d.ts` — `node:test` / `node:assert` 的最小类型声明（保持零依赖）

## 运行

```sh
npm test   # tsc 编译 + node --test
```

## 实际测试结果

环境：Node.js v22.22.1，TypeScript 7.0.2。`npm test` 通过（8/8）：

```
ok 1 - delete creates a tombstone; updates that never observed it do not restore the doc
ok 2 - restore must reference the specific deletion version
ok 3 - concurrent deletes are independent versions and each needs its own restore
ok 4 - concurrent restores preserve content branches
ok 5 - restore is retained when it arrives before the delete it references
ok 6 - merge is idempotent
ok 7 - all 720 reorderings converge: tombstone cancelled, stale update harmless, provenance intact
ok 8 - all 720 reorderings converge: concurrent restores keep both branches
# tests 8
# pass 8
# fail 0
```
