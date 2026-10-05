# groupflush

多个调用方共享一次 fsync 的刷盘库（group commit）。仅依赖 Go 标准库。

## 语义

- **共享刷盘**：`Submit` 的字节进入当前开放批次，冲刷循环对整批顺序写盘后只做一次 `Sync`，批内所有调用方一起被确认。
- **写入前封口**：批次在任何字节落盘之前封口；封口后到达的提交进入下一批，绝不能借用上一批的 fsync 提前确认。
- **失败隔离**：一次写盘/同步失败只以该错误确认本批（串行冲刷循环保证不存在更早未确认者）；循环不中止，后续批次作为全新尝试可成功，调用方也可自行重试新批。
- **取消独立**：`Submit` 的 `ctx` 取消只让该调用方提前返回 `ctx.Err()`；其字节仍随批次写盘并同步，同批其他调用方不受影响。
- **关闭**：`Close` 停止接收新提交（返回 `ErrClosed`），并等待已接收的请求全部冲刷确认。

## 用法

```go
f, _ := os.OpenFile("log", os.O_CREATE|os.O_WRONLY, 0o644)
fl := groupflush.New(f)          // *os.File 满足 groupflush.File
err := fl.Submit(ctx, record)    // 返回时 record 已随某批 fsync 落盘
fl.Close()
```

## 测试

`flusher_test.go` 中的 `controlledFile` 是可控文件器：记录每次 `Sync`
时已写入的字节数，可按需阻塞或注入写/同步错误，用于验收批次边界与
取消独立性。

实际运行结果（go1.27.1 linux/amd64，`GOCACHE=/tmp/gocache`）：

```
$ go test ./... -v
--- PASS: TestSharesOneSync (0.00s)                  # 5 个调用方共享 1 次 fsync
--- PASS: TestBatchSealedBeforeWrite (0.05s)         # 封口后追加不能借旧 fsync
--- PASS: TestSyncFailureAffectsOnlyItsBatch (0.00s) # 失败只影响本批，新批可重试
--- PASS: TestWriteFailure (0.00s)
--- PASS: TestCancellationIndependence (0.05s)       # 取消互不影响
--- PASS: TestSubmitWithCancelledContext (0.00s)
--- PASS: TestClose (0.05s)
--- PASS: TestRealFile (0.00s)
PASS
ok  	groupflush	0.166s

$ go test ./... -race -count=2
ok  	groupflush	1.351s
```
