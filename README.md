# groupflush

多个并发调用共享一次 fsync 的组提交刷盘库，仅依赖 Go 标准库。

## 语义

- **批次在写入前封口**：后台刷盘协程取走当前批次即封口，后续 `Append` 只能进入下一批。
- **后来追加不能借旧 fsync 提前确认**：新批次的数据在上一批 `Sync` 返回之后才写入，
  绝不会被上一批的 fsync 确认。
- **失败隔离**：一次 `Write`/`Sync` 失败只使该批（及更早未确认者；本实现串行刷盘，
  不存在更早未确认批次）以该错误收场，后续新批次不受影响，允许重试。
- **取消独立**：`Append` 的 `ctx` 取消只让本调用提前返回 `ctx.Err()`，
  不取消共享的 fsync，也不影响同批其他调用方；数据仍随批次落盘。

## 用法

```go
fl := groupflush.New(filer) // filer 实现 Write([]byte) / Sync() error
defer fl.Close()
err := fl.Append(ctx, data) // 返回 nil 即 data 已随某次共享 Sync 落盘
```

## 测试

验收测试使用可控文件器（`controlledFiler`）：`Sync` 阻塞在闸门处，
由测试逐次放行或注入错误，并记录 write/sync 事件序列以核验批次边界。

实测结果（go1.27.1 linux/amd64，`go test ./...`）：

```
ok  	groupflush	0.434s
```

`go test -race ./...` 同样通过（`ok groupflush 1.490s`）。覆盖：

- `TestSharedFsyncBatchesCallers`：4 次追加、2 个批次、恰好 2 次 Sync。
- `TestLateAppendNotConfirmedByOldSync`：事件序列严格为 `write,sync,write,sync`，
  旧 fsync 放行后新批次的追加仍处于未确认状态。
- `TestSyncFailureOnlyFailsThatBatch` / `TestWriteFailureOnlyFailsThatBatch`：
  失败限于当前批次，之后的新批次可重试并成功。
- `TestCancellationIndependence`：取消同批一个调用方，其他人仍被共享 fsync 正常确认。
- `TestCloseFlushesPending`：`Close` 刷完在途批次后拒绝新追加。
