# offline-sync

离线同步库：接收分页变更与下一游标，变更与游标同批原子提交；重页幂等；
同 ID 不同内容拒绝整页；可中断存储适配器支持在每个写入边界崩溃重启，
并对照一次顺序应用验证不跳过任何记录。

仅使用 TypeScript + Node.js 内置模块（`node:fs`、`node:path`、`node:test`、
`node:assert`），零 npm 依赖。需要环境中可用的 `tsc`（TypeScript 编译器）。

## 运行

```sh
npm test
```

先执行 `tsc` 编译到 `dist/`，再用 Node 内置测试运行器执行测试。
实际结果见 `RESULTS.md`。

## 设计

- `src/sync.ts` — `SyncEngine.applyPage(page)`：先校验后写入。
  - 重页检测：`page.nextCursor` 作为幂等键存入 `appliedCursors`；
    已应用过的页（包括游标已推进到更后面之后的旧页重放）直接 no-op。
  - 冲突检测：任一变更的 id 与已存内容（或同页前序变更）不同，
    抛出 `ConflictError`，整页拒绝，存储不变。
  - 通过校验后，records + cursor + appliedCursors 作为一个批次提交。
- `src/adapter.ts` — `FileStorageAdapter` 用
  write-tmp → fsync → 原子 rename → fsync-dir 协议保证批次原子性：
  rename 是唯一提交点，崩溃后磁盘上只有完整旧态或完整新态；
  撕裂写入残留的 tmp 文件在恢复时被忽略。
  `InMemoryAdapter` 作为无崩溃的参照实现。
- `src/device.ts` / `src/interruptible.ts` — `Device` 的每个写方法是一个
  写入边界；`InterruptibleDevice` 在指定边界模拟断电（可选撕裂写），
  之后设备永久失效，通过在相同目录上重建适配器模拟重启恢复。
- `src/reference.ts` — 对照 oracle：将全部页按顺序应用一次，
  记录每个前缀状态。

## 测试（test/sync.test.ts）

1. 变更与游标同批提交。
2. 重页幂等（含游标推进后重放旧页不回退）。
3. 同 ID 不同内容拒绝整页，状态与游标不变。
4. 页内重复 ID 不同内容拒绝整页。
5. 在全部 12 个写入边界（3 页 × 4 边界）逐一崩溃重启
   （含撕裂写变体），最终状态与顺序应用完全一致；
   每次重启后的中间状态必须等于顺序应用的某个前缀。
6. 确定性轮转崩溃点反复崩溃重启，最终收敛到参照结果，
   15 条记录无跳过。
7. 恢复期间收到冲突页仍整页拒绝并保持状态。
