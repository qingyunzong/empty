# archive-crdt

事件溯源的文档档案库，支持删除 / 恢复与幂等合并（CRDT）。仅使用 TypeScript 与
Node.js 内置库（`node:test`、`node:assert`），零 npm 运行时依赖。

## 语义

- **事件模型**：每次变更（`update` / `delete` / `restore`）是不可变事件，携带唯一
  id、lamport 时钟与因果前沿 `deps`。副本间通过 `merge` 交换事件；合并是按 id 去重
 的集合并集，因此**幂等、可交换、可结合**。
- **删除产生墓碑**：`delete` 生成以删除事件 id 为版本号的墓碑。
- **恢复必须引用具体删除版本**：`restore(doc, deleteRef)` 只抵消被引用的那一块
  墓碑；本地调用引用未知删除版本会抛错，合并进来的悬空 restore 则惰性无效。并发
  删除产生多块墓碑时，只恢复其中一块，文档仍处于已删除状态。
- **未观察删除的旧更新不恢复文档**：与删除并发的 `update` 既不复活文档，恢复之后
  也不会成为分支内容来源（它不在恢复点的因果未来，也不在被引用的删除版本之前）。
  只有显式 `restore` 才能复活文档。
- **并发恢复保留分支**：对同一删除版本的多个并发恢复各自保留一个分支；因果上有
  先后关系的恢复只保留最新分支。分支内容取恢复点因果之后的 LWW 更新，否则回退到
  被引用删除版本之前的内容，并记录内容来源事件 id（`contentFrom`）。

## 结构

- `src/archive.ts` — 事件类型、`Archive`（本地操作 / 合并 / 状态物化）
- `src/index.ts` — 公共导出
- `test/archive.test.ts` — `node:test` 测试

## 运行测试

```sh
npm test   # tsc 编译到 dist/ 后运行全部测试
```

## 实际测试结果

在本环境（Node v22.22.1，tsc 7.0.2）执行 `npm test` 的实际输出：

```
ok 1 - update then read returns content with provenance
ok 2 - delete creates an active tombstone; document is deleted
ok 3 - restore must reference a known delete version
ok 4 - restore cancels exactly the referenced tombstone and revives pre-delete content
ok 5 - concurrent deletes each need their own restore
ok 6 - update concurrent with a delete does not restore the document
ok 7 - concurrent restores keep one branch each
ok 8 - causally ordered restores collapse to the latest branch
ok 9 - dangling restore in a merge is inert
ok 10 - merge is idempotent and self-merge is a no-op
ok 11 - merge is commutative and associative across replicas
ok 12 - all permutations of a short event log converge on tombstones and content provenance
ok 13 - permutations with an uncancelled tombstone stay deleted in every order
1..13
# tests 13
# pass 13
# fail 0
```

其中第 12 项对 6 个短事件的全部 720 种投递顺序逐一合并，核对最终状态（含墓碑
与内容来源）完全一致，且重复合并后状态与事件数不变；第 13 项对含未抵消墓碑的
5 事件日志的全部 120 种顺序核对文档始终保持已删除。
