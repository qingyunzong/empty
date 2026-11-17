# 在线建索引协调库

数据库 DDL 执行器需要供在线建索引流程调用的 Go 协调库，在快照扫描与增量变更日志之间建立无缝水位，处理事务跨越扫描边界、回放重复和构建取消。切换可见前必须证明所有已提交键已覆盖。用事务调度生成器对照表扫描验证无漏键、无幽灵键且重放幂等。

本模块实现了这套协调协议，并提供内存事务存储、覆盖审计器和确定性事务调度生成器用于模型验证。

## 核心协议

```text
Scan -> CatchUp* -> Seal -> Publish
```

- `Scan` 打开提交序列为 `W` 的事务一致快照，将快照写入索引，并记录 `Snapshot = W`。
- `CatchUp` 将日志排空到当前高水位，可在线重复调用。
- `Seal` 固定屏障 `V`，排空 `(W, V]`，对 `V` 时刻的表做全量覆盖审计，成功后才签发不可伪造的 `Certificate`。
- `Publish` 只接受本次构建签发且仍然新鲜的证书；若日志在 `Seal` 后前进，返回 `ErrStaleCertificate`，调用方必须重新 `Seal`。

无缝水位的依据是**提交序列在提交时分配**：扫描前开始、扫描后提交的事务满足 `Seq > W`，因此不会出现在快照中，只会出现在增量日志中；`Seq <= W` 的事务已在快照中，回放时被过滤。快照原子、日志对该表完整时，`Snapshot + (W, Drained]` 精确覆盖 `Drained` 时刻的全部已提交键。

## 使用

```go
store := formal.NewMemStore() // 生产环境替换为快照源和变更日志适配器
index := formal.NewMemIndex()

c, err := formal.New(formal.Config{
    Snapshots: store,
    Log:       store,
    Index:     index,
    Audit:     formal.SnapshotAuditor{Source: store},
})
if err != nil {
    return err
}

if err := c.Scan(ctx); err != nil { // 建立快照水位
    return err
}
if _, err := c.CatchUp(ctx); err != nil { // 可重复调用
    return err
}
cert, err := c.Seal(ctx) // 排空 + 覆盖审计 + 签发证书
if err != nil {
    return err
}
if err := c.Publish(ctx, cert); err != nil { // 校验新鲜度后切换可见
    return err
}
```

`Scan` 必须作用于空索引。`Cancel` 可随时中断阻塞的快照扫描或日志读取；取消后索引可能只构建了一部分，调用方应丢弃，且 `Publish` 永远返回 `ErrCanceled`。

## 关键类型

- `ChangeLog`：要求按提交序列返回完整事务，允许重复投递；`Batch.Done` 是区间耗尽的权威信号。
- `Snapshot` / `SnapshotSource`：快照在 `Watermark` 处必须事务原子。
- `Coordinator`：状态机 `new -> scanning -> replaying -> sealed -> visible`，失败或取消进入终态。
- `Certificate`：记录快照水位、屏障、提交/变更计数和重放摘要，并携带构建身份令牌。
- `Auditor` / `SnapshotAuditor`：可见前的全表覆盖证明；审计失败使构建失败。
- `Compare`：对照权威快照，报告 `Missing`、`Ghosts` 和 `Mismatched`。
- `schedgen.Generate`：生成包含跨界事务、扫描后写删、回滚和取消的确定性调度。

## 验证

测试使用 `schedgen` 生成多组事务调度，执行真实的 `Scan/CatchUp/Seal/Publish` 流程，并在屏障处重新打开历史快照对照索引：

- 无漏键：`Report.Missing` 为空。
- 无幽灵键：`Report.Ghosts` 为空。
- 值一致：`Report.Mismatched` 为空。
- 重放幂等：同一调度分别使用普通日志和注入陈旧/重复记录的日志执行，索引、证书摘要、提交数、变更数和屏障完全一致。
- 取消安全：扫描中取消、Seal 后取消均无法发布。
- 陈旧证书：`Seal` 后日志前进时 `Publish` 拒绝，重新 `Seal` 后可发布。

```bash
go test ./...
go test -race ./...
```
