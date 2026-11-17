# 事务日志组提交组件

`formal.GroupCommitter` 是供数据库提交器调用的 Go 组提交组件。并发事务把各自的提交记录交给同一个顺序写入器：同一批记录共享一次连续的 `WriteAt` 序列和一次 `Sync`，但每个调用只有在其记录的 `EndLSN` 不大于持久 LSN 后才返回成功。

## 使用

```go
dev, err := os.OpenFile("wal.log", os.O_RDWR|os.O_CREATE, 0o600)
if err != nil {
    return err
}
committer, err := formal.OpenGroupCommitter(dev, 1<<30)
if err != nil {
    return err
}
defer committer.Close()

result, err := committer.Commit(ctx, txID, commitPayload)
if err != nil {
    // 该事务的提交记录没有被确认持久化。
    return err
}
// result.EndLSN <= committer.DurableLSN()
```

`OpenGroupCommitter` 在启动时扫描并恢复已有的持久前缀，然后从持久 LSN 继续追加。`payload` 对组件不透明；`TransactionID` 用于恢复后把记录关联回事务，调用方应保证其唯一。

如果调用方需要一次共享写入的字节上限，可在开始提交前调用 `SetMaxGroupBytes`。单条记录始终允许单独成组。

## 保证

- **顺序写**：只有一个写协程推进日志末尾；记录按提交顺序排列。
- **批量 fsync**：写协程取走当时排队的所有可提交记录，编码成一个组，完成整组写入后只 fsync 一次。
- **按记录应答**：组 fsync 成功后才更新 `DurableLSN`，随后才唤醒组内等待者。每个等待者的 `EndLSN` 都小于等于本次更新后的持久 LSN。
- **短写**：`WriteAt` 返回短计数时继续写剩余字节；零进度或带错误的短写使整组失败，持久 LSN 不前进。
- **fsync 失败**：持久 LSN 保持在上一成功组的末尾；失败组内的调用全部返回错误。下一次追加从该持久边界重新开始。
- **取消**：记录仍在队列中时取消会移除该记录并返回 `context.Canceled`；记录一旦被写协程取入组，提交即线性化，此时取消不会把一次实际成功的持久提交报告为取消。这样不会出现“恢复后可见但调用方认为未提交”的事务。
- **关闭**：`Close` 停止接收新记录并排空已排队记录，但不会额外执行一次 fsync，避免把失败组的残留字节在关闭时意外固化。

`DurableLSN` 只表示逻辑上可恢复到的末尾。物理设备上可能存在更靠后的失败组残留字节，恢复扫描通过格式校验把它们排除。

## 磁盘格式与恢复

日志由自描述的组构成：

```
组头（magic/version/generation/startLSN/totalLen/recordCount/payloadBytes/CRC）
记录头 + payload（可重复，记录头含绝对 startLSN 和 payload CRC32C）
组尾（generation/totalLen/整组 CRC32C）
```

`Recover` 从偏移 0 开始扫描完整且校验通过的组，遇到第一个损坏、截断或代数不递增的组即停止；之后的内容不属于可见前缀。恢复结果中的 `Records` 就是崩溃恢复后可以变为可见的事务集合。记录头中的绝对偏移和组代数还会阻止失败组遗留在设备上的旧字节被误认为新记录。

## 故障注入验证

`commit_test.go` 中的 `faultDevice` 模拟带易失写缓存的块设备：

- `WriteAt` 只改易失镜像，并可注入固定长度短写或零进度写入；
- `Sync` 在无故障时原子发布易失镜像，可注入指定次数的 fsync 失败或掉电；
- `Crash` 丢弃全部未成功同步的字节。

测试覆盖并发组提交共享 fsync、短写、零进度写、fsync 失败后继续提交、等待者取消、日志容量耗尽、重启续写，以及在不同 fsync 点掉电。每个用例最后都比较“返回成功的应答集合”与“`Recover` 得到的可见事务集合”，要求二者完全相同。

```sh
go test ./...
go test -race ./...
```
