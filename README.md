# shardmig

键区间分片迁移处理库，仅使用 Go 标准库。

## 设计

- **区间语义**：`Range` 为半开区间 `[Lo, Hi)`，边界键（分裂点）归右区间；`Hi == ""` 表示无上界。
- **迁移流程**：`Store.BeginMigration` 分配新世代（epoch），旧分片保留路由并对迁移区间**转发**到新分片；新分片提升为新世代，**只有新世代可提交**，旧世代提交被 fence（`ErrStaleEpoch`）。`Store.Complete` 原子迁移数据并切换路由；`Store.Abort` 回滚中断的迁移。
- **已处理 ID 一并迁移**：已处理集合记录为 `消息ID → key`，随区间内数据在同一临界区原子迁移，迁移后重投仍被去重。
- **单次业务效果**：消息按 ID 幂等去重，效果与已处理记录在同一锁内原子提交，离散消息重复投递只生效一次。
- **中断验收**：`Complete` 幂等可重试；`Abort` 将新分片已接受的状态完整回迁、清除转发并恢复世代，状态不留半截。

## 文件

- `shard.go`：`Range`、`Message`、`Shard`（转发、fence、幂等提交、原子迁移）
- `store.go`：`Store`（路由表、世代分配）、`Migration`（Begin/Complete/Abort）
- `shardmig_test.go`：8 个测试覆盖全部验收点

## 实测结果

```
$ go test ./...
ok  	shardmig	0.007s

$ go test -race -count=1 ./...
ok  	shardmig	1.045s
```

8 个测试全部通过（含 `-race`）：

- `TestBoundaryKeyBelongsToRightInterval` — 边界键归右区间
- `TestMigrationForwardsAndFencesOldGeneration` — 迁移期间旧分片转发，只新世代可提交
- `TestProcessedIDsMigrateWithRange` — 已处理 ID 随区间迁移，迁移后重投不重复生效
- `TestDuplicateDeliverySingleEffect` — 离散消息重复投递单次业务效果
- `TestAbortMigrationRestoresCompleteState` — 中断回滚后状态完整
- `TestCompleteIsIdempotentAfterInterruption` — 中断后重试 Complete 收敛同一状态
- `TestConcurrentDuplicateDelivery` / `TestConcurrentMigrationWindow` — 并发去重与迁移窗口（race 检测通过）

注：本环境 `~/.cache/go-build` 只读，需 `GOCACHE=/tmp/gocache go test ./...`。
