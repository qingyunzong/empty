# offline-sync

离线同步库（TypeScript，仅 Node.js 内置库，零依赖）。接收分页变更及下一游标，
将**变更与游标作为同一批次原子提交**；重页幂等；同 ID 不同内容拒绝整页。

## 保证

- **同批原子提交**：一页的 `changes` 与 `nextCursor` 经
  `FileStorageAdapter.commitBatch` 一次性落盘（写临时文件 → fsync →
  原子 rename → fsync 目录）。崩溃后恢复只会看到提交前或提交后的完整状态，
  绝不出现"有变更无游标"或反之的中间态。
- **重页幂等**：重复应用同一页（同 ID、同内容）成功且为无操作。
- **整页拒绝**：任一记录 ID 已存在且内容不同（或页内同 ID 内容冲突），
  抛出 `PageConflictError`，整页不提交，已有状态不变。
- **可中断存储适配器**：`CrashInjector` 作为 `onBoundary` 钩子注入
  `FileStorageAdapter`，在任意写入边界（`temp-write` / `temp-fsync` /
  `rename` / `dir-fsync`）模拟硬崩溃；"重启"= 在同一目录上新建适配器实例，
  从磁盘恢复（丢弃未提交的临时文件），重放整段变更流，已提交的页幂等跳过。
- **对照顺序应用**：崩溃矩阵测试将"在每个写入边界崩溃并重启后跑完"的最终
  状态，与内存适配器上一次不间断顺序应用的结果逐字段比对，且断言记录数
  等于全部页变更数（不跳过任何记录）。

## 结构

- `src/types.ts` — `Change` / `Page` / `Batch` / `Snapshot` / `StorageAdapter` 契约
- `src/sync.ts` — `SyncEngine.applyPage`：冲突校验 → 原子批量提交
- `src/fileStorage.ts` — 文件适配器，temp+rename 原子提交，4 个写入边界
- `src/memoryStorage.ts` — 内存适配器，用作顺序应用参照
- `src/interruptible.ts` — `CrashInjector` 崩溃注入钩子
- `src/errors.ts` — `PageConflictError` / `CrashError`
- `test/sync.test.ts` — 6 个 `node:test` 用例

## 运行

```sh
npm test        # tsc 编译 + node --test
npm run typecheck
```

环境：Node.js v22.22.1，TypeScript 7.0.2（全局 tsc），无 npm 依赖。

## 实际测试结果（2026-10-05 记录）

`npm test` 退出码 0：

```
> tsc -p tsconfig.json && node --test dist/test/*.test.js
TAP version 13
# Subtest: dist/test/sync.test.js
ok 1 - dist/test/sync.test.js
# tests 1
# pass 1
# fail 0
```

逐用例明细（`node dist/test/sync.test.js`，退出码 0）：

```
ok 1 - commits a page's changes and cursor in one batch
ok 2 - re-applying the same page is idempotent
ok 3 - same id with different content rejects the whole page
ok 4 - conflicting duplicate id inside one page rejects the page
ok 5 - recovery discards an uncommitted batch after a crash
ok 6 - restart at every write boundary matches one sequential apply
1..6
# tests 6
# pass 6
# fail 0
```

其中用例 6 对 6 页 × 4 条记录的变更流，在全部 24 个写入边界
（6 页 × 4 边界）逐一注入崩溃、重启恢复并跑完，最终状态均与一次
顺序应用完全一致，记录无跳过、游标一致。`npm run typecheck` 通过。
