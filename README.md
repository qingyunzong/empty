# pagestore

Go 实现的写时复制（copy-on-write）MVCC 页库，演示事务写入的额度记账与原子根切换。

## 设计

- **事务草稿**：`Tx` 把写入缓冲在内存草稿中，提交前不占用任何页额度。
- **额度守恒**：`Stats` 满足不变量 `Free + Used == Capacity`。提交时一次性预留所需新页；任何失败（额度不足 `ErrQuotaExceeded`、后端 `WritePages`/`WriteRoot` 错误）都会回滚预留，根指针不动，草稿保留可重试。
- **原子根切换**：提交在锁内一次性替换根版本；读者只能看到完整的新旧版本之一，不会看到撕裂状态。
- **读者钉住与回收**：`Reader` 钉住一个版本，期间该版本的旧页即使被新提交覆盖也不会回收；`Close` 释放后，无任何活版本引用的页回到空闲池。
- **失败写适配器**：`FailBackend` 包装 `MemBackend`，可注入页写失败与根写失败，用于核验失败路径的原子性与额度回滚。

## 测试

```sh
go test ./...          # 单元与并发测试
go test ./... -race    # 竞态检测
```

覆盖：容量守恒（`TestCapacityConservation`）、额度不足拒绝提交且草稿不破坏（`TestCommitRejectedWhenQuotaInsufficient`）、旧读者读旧页与释放后回收（`TestOldReadersKeepOldPages`）、失败写适配器（`TestFailingWriteAdapter`）、并发原子根切换（`TestAtomicRootSwitchConcurrent`）。
