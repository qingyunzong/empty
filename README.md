# formal

面向流处理 sink 算子的 Go 两阶段提交库。它把事务开启、预提交、提交决定、
sink 回执和故障恢复统一到一条持久化提交日志中。

## 语义

- `Begin -> Prepare -> Commit` 是正常路径，`Abort` 可终止 open/prepared 事务。
- `Prepare` 将完整记录与摘要写入日志并 fsync，但事务仍只存在于 in-flight 集合。
- `Commit` 先追加并 fsync commit 帧；只有该提交点落盘后，事务才进入 committed 视图。
- prepared 事务恢复后仍是 prepared，可安全重试 `Commit`；不会被误判为已提交。
- 已提交事务的 `Receipt`（事务号、prepare/commit 序号、摘要、记录数）跨重启稳定。
- 重复 `Commit`、重复 `Abort`、重复 sink 交付都返回原结果或成为无操作。
- 非空 `Record.ID` 在一次事务内唯一，并且只能属于一个已提交事务。

## 快速使用

```go
coordinator, err := formal.Open("/var/lib/example/commit",
    formal.WithSink(sink),
)
if err != nil {
    return err
}
defer coordinator.Close()

tx, err := coordinator.Begin(ctx, "checkpoint-42")
if err != nil {
    return err
}
if err := tx.Append(
    formal.Record{ID: "event-1", Data: payload1},
    formal.Record{ID: "event-2", Data: payload2},
); err != nil {
    return err
}
if _, err := tx.Prepare(ctx); err != nil {
    return err
}
receipt, err := tx.Commit(ctx)
if err != nil {
    return err
}
```

`WithSink` 的 `Apply` 必须按 `TxnID`（以及 `CommitSeq`）幂等。恢复可能重放
“外部效果已完成、ack 尚未落盘”的交付；`MemorySink` 提供了幂等参考实现。
如果 sink 暂时失败，commit 决定仍然有效，稍后调用 `Commit` 或 `Recover`
只重试交付。

## 可见性

```go
prepared := coordinator.InFlight()       // open + prepared，仅在途
committed := coordinator.Committed()     // 只含已越过提交点的事务
output := coordinator.CommittedRecords() // 按提交序号展开的输出记录
```

prepared 数据不会出现在 `Committed`/`CommittedRecords` 中，也不会提前调用 sink。

## 崩溃测试

`WithCheckpoint` 可在每个持久化/可见性边界注入崩溃：

```go
checkpoint, _ := formal.Open(dir,
    formal.WithSink(sink),
    formal.WithCheckpoint(func(point formal.CrashPoint) error {
        if point == formal.CrashAfterSinkApply {
            return formal.ErrCrash
        }
        return nil
    }),
)
```

测试枚举全部 `AllCrashPoints()`，删除旧 coordinator 后用同一目录重新
`Open`，校验日志重放、in-flight/committed 分区、稳定回执和记录恰好一次可见。

```bash
go test -race ./...
```
